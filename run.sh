#!/usr/bin/env bash
# Downbeat: one-command setup and launcher.
#
#   ./run.sh                 set up anything missing, then open the studio
#   ./run.sh --setup         only set up (install / build), don't launch
#   ./run.sh --yes ...       install missing system packages without asking
#   ./run.sh --port 8766     any other flags go to `python -m downbeat`
#
# On a brand-new machine this offers to install, in order: Homebrew (macOS), ffmpeg, Python 3.10+
# and Node.js 20.19+ (via Homebrew on macOS, the distro package manager plus nvm on Linux).
# Python and npm packages always go into this folder (.venv/ and node_modules/), never system-wide.
set -euo pipefail

cd "$(dirname "$0")"

SETUP_ONLY=0
ASSUME_YES="${DOWNBEAT_YES:-0}"
ARGS=()
for a in "$@"; do
  case "$a" in
    --setup) SETUP_ONLY=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    *) ARGS+=("$a") ;;
  esac
done

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# Ask before installing anything outside this folder. Without a terminal (CI, scripts) and without
# --yes, print the command instead and stop.
confirm() {
  if [ "$ASSUME_YES" = "1" ]; then return 0; fi
  if [ ! -t 0 ]; then return 1; fi
  printf '\033[1;36m??\033[0m  %s [Y/n] ' "$1"
  read -r reply
  case "$reply" in [nN]*) return 1 ;; *) return 0 ;; esac
}

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM=mac ;;
  Linux) PLATFORM=linux ;;
  MINGW*|MSYS*|CYGWIN*) die "Native Windows shells aren't supported. Install WSL (see README → Windows) and run ./run.sh inside Ubuntu." ;;
  *) die "Unsupported OS: $OS" ;;
esac

# ---- package managers -------------------------------------------------------------------------
load_brew() {
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew /home/linuxbrew/.linuxbrew/bin/brew; do
    if [ -x "$b" ]; then eval "$("$b" shellenv)"; return 0; fi
  done
  command -v brew >/dev/null 2>&1
}

ensure_brew() {
  load_brew && return 0
  warn "Homebrew (the macOS package manager) is not installed."
  if ! xcode-select -p >/dev/null 2>&1; then
    warn "Apple's Command Line Tools are missing too. Homebrew's installer will set them up."
  fi
  confirm "Install Homebrew now? (asks for your Mac password)" \
    || die "Install Homebrew from https://brew.sh, then run ./run.sh again."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  load_brew || die "Homebrew installed, but 'brew' is not on PATH. Open a new Terminal window and run ./run.sh again."
}

linux_pm() {
  if command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf >/dev/null 2>&1; then echo dnf
  elif command -v pacman >/dev/null 2>&1; then echo pacman
  elif command -v zypper >/dev/null 2>&1; then echo zypper
  else echo none
  fi
}

# install_pkgs "<what, for the prompt>" <mac formulae> -- <apt> -- <dnf> -- <pacman> -- <zypper>
install_pkgs() {
  local what="$1"; shift
  local mac="" apt="" dnf="" pac="" zyp="" slot=0
  for x in "$@"; do
    if [ "$x" = "--" ]; then slot=$((slot + 1)); continue; fi
    case $slot in
      0) mac="$mac $x" ;; 1) apt="$apt $x" ;; 2) dnf="$dnf $x" ;; 3) pac="$pac $x" ;; 4) zyp="$zyp $x" ;;
    esac
  done
  if [ "$PLATFORM" = mac ]; then
    ensure_brew
    confirm "Install $what with Homebrew (brew install$mac)?" || die "Run: brew install$mac"
    # shellcheck disable=SC2086
    brew install $mac
    return
  fi
  local sudo=""
  [ "$(id -u)" -ne 0 ] && sudo="sudo"
  case "$(linux_pm)" in
    apt)
      confirm "Install $what with apt ($sudo apt-get install$apt)?" || die "Run: $sudo apt-get install -y$apt"
      $sudo apt-get update -qq
      # shellcheck disable=SC2086
      $sudo apt-get install -y $apt ;;
    dnf)
      confirm "Install $what with dnf?" || die "Run: $sudo dnf install -y$dnf"
      # shellcheck disable=SC2086
      $sudo dnf install -y $dnf ;;
    pacman)
      confirm "Install $what with pacman?" || die "Run: $sudo pacman -S --needed$pac"
      # shellcheck disable=SC2086
      $sudo pacman -S --needed --noconfirm $pac ;;
    zypper)
      confirm "Install $what with zypper?" || die "Run: $sudo zypper install -y$zyp"
      # shellcheck disable=SC2086
      $sudo zypper install -y $zyp ;;
    *) die "Couldn't find apt, dnf, pacman or zypper. Install $what yourself, then run ./run.sh again." ;;
  esac
}

# ---- ffmpeg ---------------------------------------------------------------------------------
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  [ "$PLATFORM" = mac ] && load_brew || true
fi
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  warn "ffmpeg (video encoding and analysis) is not installed."
  install_pkgs "ffmpeg" ffmpeg -- ffmpeg -- ffmpeg-free -- ffmpeg -- ffmpeg
  hash -r
  command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg still isn't on PATH. Open a new terminal and run ./run.sh again."
fi

# Proxies and some exports encode with libx264. Fedora's default ffmpeg-free leaves it out; the
# full build comes from RPM Fusion. (Captured first: `grep -q` + pipefail would trip on SIGPIPE.)
has_x264() { case "$(ffmpeg -hide_banner -encoders 2>/dev/null || true)" in *libx264*) return 0 ;; *) return 1 ;; esac; }
if ! has_x264; then
  warn "This ffmpeg can't encode H.264 with libx264, which Downbeat needs."
  if [ "$PLATFORM" = linux ] && [ "$(linux_pm)" = dnf ] && command -v rpm >/dev/null 2>&1; then
    sudo=""
    [ "$(id -u)" -ne 0 ] && sudo="sudo"
    rpmfusion="https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm"
    confirm "Enable RPM Fusion and swap ffmpeg-free for the full ffmpeg?" \
      || die "Run: $sudo dnf install -y $rpmfusion && $sudo dnf swap -y ffmpeg-free ffmpeg --allowerasing"
    $sudo dnf install -y "$rpmfusion"
    $sudo dnf swap -y ffmpeg-free ffmpeg --allowerasing
    hash -r
  elif [ "$PLATFORM" = mac ]; then
    die "Reinstall Homebrew's ffmpeg (brew reinstall ffmpeg), or put a full ffmpeg build first on your PATH."
  else
    die "Install a full ffmpeg build (one listing libx264 in 'ffmpeg -encoders'), then run ./run.sh again."
  fi
  has_x264 || die "ffmpeg still lacks libx264."
fi

# ---- Python 3.10+ -----------------------------------------------------------------------------
py_ok() { "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; }
find_python() {
  local c
  for c in "${PYTHON:-}" python3.13 python3.12 python3.11 python3.10 python3 python; do
    [ -n "$c" ] && command -v "$c" >/dev/null 2>&1 && py_ok "$c" && { command -v "$c"; return 0; }
  done
  return 1
}

if [ ! -x .venv/bin/python ]; then
  [ "$PLATFORM" = mac ] && load_brew || true
  PYTHON_BIN="$(find_python || true)"
  if [ -z "$PYTHON_BIN" ]; then
    warn "Python 3.10 or newer is not installed."
    install_pkgs "Python 3" python@3.12 -- python3 python3-venv python3-pip -- python3 python3-pip -- python python-pip -- python3 python3-pip
    hash -r
    PYTHON_BIN="$(find_python || true)"
    [ -n "$PYTHON_BIN" ] || die "Python 3.10+ still not found. Install it from https://www.python.org/downloads/ and run ./run.sh again."
  fi
  say "Creating .venv with $("$PYTHON_BIN" --version 2>&1)"
  if ! "$PYTHON_BIN" -m venv .venv 2>/dev/null; then
    rm -rf .venv
    # Debian / Ubuntu split venv + ensurepip into a separate package.
    if [ "$PLATFORM" = linux ] && [ "$(linux_pm)" = apt ]; then
      ver="$("$PYTHON_BIN" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"
      install_pkgs "Python venv support" -- "python${ver}-venv" -- -- --
      "$PYTHON_BIN" -m venv .venv || die "Could not create a virtual environment with $PYTHON_BIN."
    else
      die "Could not create a virtual environment with $PYTHON_BIN."
    fi
  fi
fi

# (Re)install the Python package when it's missing or pyproject.toml changed (e.g. after git pull).
STAMP=.venv/.downbeat-installed
if [ ! -f "$STAMP" ] || [ pyproject.toml -nt "$STAMP" ] || ! ./.venv/bin/python -c "import cv2, numpy" >/dev/null 2>&1; then
  say "Installing Python packages into .venv (numpy, opencv)"
  ./.venv/bin/python -m pip install --upgrade pip -q
  ./.venv/bin/python -m pip install -e . -q
  touch "$STAMP"
fi

# ---- Node.js 20.19+ (builds the studio UI) ------------------------------------------------------
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22 ? 0 : 1)' >/dev/null 2>&1
}
# nvm's scripts aren't written for `set -eu`, so relax it around them.
load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  set +eu
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use --lts >/dev/null 2>&1
  set -eu
  return 0
}

need_build=0
if [ ! -f downbeat/studio/dist/index.html ]; then
  need_build=1
elif [ -n "$(find downbeat/studio -path downbeat/studio/dist -prune -o -type f -newer downbeat/studio/dist/index.html -print | head -n 1)" ] \
  || [ package.json -nt downbeat/studio/dist/index.html ] || [ vite.config.ts -nt downbeat/studio/dist/index.html ]; then
  need_build=1
fi

if [ "$need_build" = 1 ] || [ ! -d node_modules ]; then
  [ "$PLATFORM" = mac ] && load_brew || true
  node_ok || load_nvm
  if ! node_ok; then
    if command -v node >/dev/null 2>&1; then warn "Node.js $(node -v) is too old; the studio build needs 20.19+ or 22.12+."
    else warn "Node.js (used to build the studio UI) is not installed."; fi
    if [ "$PLATFORM" = mac ]; then
      ensure_brew
      if brew list node >/dev/null 2>&1; then
        confirm "Upgrade Node.js with Homebrew (brew upgrade node)?" || die "Run: brew upgrade node"
        brew upgrade node
      else
        install_pkgs "Node.js" node -- -- -- --
      fi
    else
      # Distro Node packages are often too old for Vite; nvm installs the current LTS into ~/.nvm
      # without sudo.
      command -v curl >/dev/null 2>&1 || install_pkgs "curl" curl -- curl -- curl -- curl -- curl
      confirm "Install Node.js LTS with nvm (into ~/.nvm, no sudo)?" \
        || die "Install Node.js 22 LTS from https://nodejs.org, then run ./run.sh again."
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
      load_nvm
      set +eu
      nvm install --lts
      nvm use --lts >/dev/null
      set -eu
    fi
    hash -r
    node_ok || die "Node.js 20.19+ still not found. Open a new terminal and run ./run.sh again."
  fi
fi

if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  say "Installing studio packages into node_modules (npm ci)"
  npm ci --no-audit --no-fund --loglevel=error || npm install --no-audit --no-fund --loglevel=error
  need_build=1
fi

if [ "$need_build" = 1 ]; then
  say "Building the studio UI"
  npm run build --silent
fi

if [ "$SETUP_ONLY" = 1 ]; then
  say "Setup complete. Start the studio with ./run.sh"
  exit 0
fi

say "Starting Downbeat"
exec ./.venv/bin/python -m downbeat ${ARGS[@]+"${ARGS[@]}"}
