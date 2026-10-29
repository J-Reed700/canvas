.PHONY: run studio setup install test e2e list clean

# Everything goes through run.sh (POSIX) or run.ps1 (native Windows), which install anything missing
# (ffmpeg, Python, Node, packages) and rebuild the studio UI when its sources changed.

# On native Windows, make has no POSIX shell to run ./run.sh with, so drive run.ps1 through
# PowerShell instead. MSYS2/Git Bash/WSL set an OS of their own, so they keep the POSIX path.
ifeq ($(OS),Windows_NT)
  SHELL := cmd.exe
  .SHELLFLAGS := /c
  RUN := powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1
  VENV_PYTHON := .venv\Scripts\python.exe
  RM_BUILD := for %%d in (build dist downbeat\studio\dist __pycache__ downbeat\__pycache__ tests\__pycache__) do @if exist "%%d" rd /s /q "%%d"
  RM_EGGINFO := for /d %%d in (*.egg-info) do @rd /s /q "%%d"
else
  RUN := ./run.sh
  VENV_PYTHON := ./.venv/bin/python
  RM_BUILD := rm -rf build dist __pycache__ downbeat/__pycache__ tests/__pycache__ downbeat/studio/dist
  RM_EGGINFO := rm -rf *.egg-info
endif

run: studio

studio:
	$(RUN) --studio

setup:
	$(RUN) --setup

install: setup

test: setup
	$(VENV_PYTHON) -m unittest discover -s tests -v
ifeq ($(OS),Windows_NT)
	@where node >nul 2>&1 && (node --test tests/*.test.mjs && npx vitest run) || echo Skipping JS tests: node not found
else
	@if command -v node >/dev/null 2>&1; then node --test tests/*.test.mjs && npx vitest run; fi
endif

# Real server + headless Chrome + one real export; skips itself without Chrome or ffmpeg.
e2e: setup
	node --test --test-concurrency=1 tests/e2e/*.test.mjs

list: setup
	$(VENV_PYTHON) -m downbeat --list

clean:
	$(RM_BUILD)
	$(RM_EGGINFO)
