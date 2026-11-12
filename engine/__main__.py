"""Run one engine step: python -m engine <step> [project id]."""
import sys

from . import media, render, upkeep, words

PROJECT_STEPS = {
    "prepare": media.prepare, "assemble": media.assemble, "silences": media.silences,
    "fillers": words.fillers, "cuts": words.cuts, "describe": words.describe, "render": render.render,
}
PLAIN_STEPS = {"cleanup": upkeep.cleanup, "health": upkeep.health}


def process(pid: str) -> None:
    """Run every loot-process step in order, without Swamp.

    The app uses this only when Swamp cannot run (for example when it is not
    signed in on the server). The order and failure rules match the workflow.
    """
    for name in ("prepare", "assemble", "silences", "fillers"):
        PROJECT_STEPS[name](pid)
    for name in ("cuts", "describe"):  # allowed to fail, like the workflow steps
        try:
            PROJECT_STEPS[name](pid)
        except SystemExit as e:
            print(f"{name} failed and was skipped: {e}")


def main() -> None:
    args = sys.argv[1:]
    if args[:1] == ["process"] and len(args) == 2:
        process(args[1])
    elif args[:1] == ["describe-again"] and len(args) == 2:
        words.describe(args[1], again=True)
    elif args[:1] == ["prep"] and len(args) == 3:
        media.prep(args[1], args[2])
    elif args and args[0] in PROJECT_STEPS and len(args) == 2:
        PROJECT_STEPS[args[0]](args[1])
    elif args and args[0] in PLAIN_STEPS and len(args) == 1:
        PLAIN_STEPS[args[0]]()
    else:
        steps = ", ".join([*PROJECT_STEPS, *PLAIN_STEPS])
        raise SystemExit(f"usage: python -m engine <step> [project id]\nsteps: {steps}")


if __name__ == "__main__":
    main()
