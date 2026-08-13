"""Compatibility shims for the vendored comic-text-detector.

The repo has been dormant since Aug 2023 and targets roughly Python 3.9 /
NumPy 1.x / setuptools <81. None of it survives contact with a 2026 venv.
Rather than patch the GPL checkout in vendor/ -- where the edits are lost
the moment anyone re-clones it, and where they muddy the license story --
the incompatibilities are absorbed here and applied immediately before the
vendored package is first imported.

Everything below is a straight restoration of something upstream removed.
If a shim ever needs to do more than that, it is time to swap the detector
backend instead (see app/detector.py).
"""

from __future__ import annotations

import logging
import sys
import types

log = logging.getLogger(__name__)

_applied = False


def _shim_pkg_resources() -> None:
    """setuptools >=81 dropped pkg_resources.

    utils/yolov5_utils.py imports it solely for parse_version, in a
    check_version() helper whose only live caller is a `torch >= 1.10`
    meshgrid test. packaging.version.parse is the documented successor and
    the comparison semantics are the ones parse_version already had.
    """
    if "pkg_resources" in sys.modules:
        return
    try:
        import pkg_resources  # noqa: F401
    except ModuleNotFoundError:
        from packaging.version import parse as parse_version

        module = types.ModuleType("pkg_resources")
        module.parse_version = parse_version  # type: ignore[attr-defined]
        sys.modules["pkg_resources"] = module


def _shim_torchsummary() -> None:
    """basemodel.py imports torchsummary.summary at module scope but only
    calls it under `if __name__ == '__main__'`, i.e. in the training entry
    point we never touch. torchsummary itself has been unmaintained since
    2018, so we satisfy the import rather than install it."""
    if "torchsummary" in sys.modules:
        return
    try:
        import torchsummary  # noqa: F401
    except ModuleNotFoundError:
        module = types.ModuleType("torchsummary")

        def summary(*args, **kwargs):  # pragma: no cover - dead path
            raise NotImplementedError(
                "torchsummary is not installed; this is the vendored repo's "
                "training entry point, which Yomi does not use."
            )

        module.summary = summary  # type: ignore[attr-defined]
        sys.modules["torchsummary"] = module


def _shim_wandb() -> None:
    """utils/general.py imports wandb at module scope, and basemodel.py pulls
    CUDA/DEVICE from that module -- so an unimportable wandb takes down the
    whole detector. It is referenced only by the Loggers training class, so a
    stub keeps the import chain alive without a heavyweight experiment-tracking
    dependency in a sidecar that will never train anything."""
    if "wandb" in sys.modules:
        return
    try:
        import wandb  # noqa: F401
    except ModuleNotFoundError:
        module = types.ModuleType("wandb")

        def _unavailable(*args, **kwargs):  # pragma: no cover - dead path
            raise NotImplementedError(
                "wandb is not installed; it is only needed by the vendored "
                "repo's training loggers, which Yomi does not use."
            )

        module.init = _unavailable  # type: ignore[attr-defined]
        sys.modules["wandb"] = module


def _shim_numpy_aliases() -> None:
    """NumPy 2.0 removed these three spellings. Each maps to the exact type
    the alias stood for, so this changes no behaviour:

      np.bool8  -> np.bool_    utils/io_utils.py    (NumpyEncoder)
      np.float_ -> np.float64  utils/io_utils.py    (NumpyEncoder)
      np.int0   -> np.intp     utils/imgproc_utils.py (boxPoints rounding)
    """
    import numpy as np

    for name, replacement in (
        ("bool8", np.bool_),
        ("float_", np.float64),
        ("int0", np.intp),
    ):
        if not hasattr(np, name):
            setattr(np, name, replacement)


def apply() -> None:
    """Idempotent. Safe to call before every vendored import."""
    global _applied
    if _applied:
        return
    _shim_pkg_resources()
    _shim_torchsummary()
    _shim_wandb()
    _shim_numpy_aliases()
    _applied = True
    log.debug("comic-text-detector compatibility shims applied")
