.PHONY: run studio install test list clean

run: studio

studio: install
	./.venv/bin/python -m canvasforge --studio

install:
	@if [ ! -d ".venv" ]; then python3 -m venv .venv; fi
	@./.venv/bin/python -c "import cv2, numpy" >/dev/null 2>&1 || ./.venv/bin/pip install -e .

test: install
	./.venv/bin/python -m unittest discover -s tests -v

list: install
	./.venv/bin/python -m canvasforge --list

clean:
	rm -rf build dist *.egg-info __pycache__ canvasforge/__pycache__ tests/__pycache__
