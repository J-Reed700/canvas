.PHONY: run studio setup install test list clean

# Everything goes through run.sh, which installs anything missing (ffmpeg, Python, Node, packages)
# and rebuilds the studio UI when its sources changed.

run: studio

studio:
	./run.sh --studio

setup:
	./run.sh --setup

install: setup

test: setup
	./.venv/bin/python -m unittest discover -s tests -v
	@if command -v node >/dev/null 2>&1; then node --test tests/studio.test.mjs; fi

list: setup
	./.venv/bin/python -m downbeat --list

clean:
	rm -rf build dist *.egg-info __pycache__ downbeat/__pycache__ tests/__pycache__ downbeat/studio/dist
