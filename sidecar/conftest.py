# Presence of this file makes pytest treat sidecar/ as the rootdir and put it on
# sys.path, so `import app` resolves under a bare `pytest -q` and not only under
# `python -m pytest` (which adds the cwd itself). tests/ has no __init__.py, so
# without this pytest would prepend sidecar/tests/ instead and app/ stays hidden.
