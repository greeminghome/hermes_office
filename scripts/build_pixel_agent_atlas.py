from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "design" / "agent-sprites" / "pixel-v1"
OUTPUT = ROOT / "public" / "agents" / "pixel-agent-atlas-v1.png"

SOURCE_SHEETS = [
    SOURCE_DIR / "team-a-alpha.png",
    SOURCE_DIR / "team-b-alpha.png",
    SOURCE_DIR / "team-c-alpha.png",
]

SOURCE_COLUMNS = 7
SOURCE_ROWS = 3
TARGET_CELL = (128, 160)

# Runtime order: down A/B, left A/B, up A/B, right A/B.
# Source order: down, up A, right A, left A, up B, right B, left B.
FRAME_MAP = [0, 0, 3, 6, 1, 4, 2, 5]


def crop_visible_sprite(cell: Image.Image) -> Image.Image:
    alpha = cell.getchannel("A")
    visible = alpha.point(lambda value: 255 if value > 24 else 0)
    bounds = visible.getbbox()
    if not bounds:
        raise RuntimeError("Sprite cell does not contain visible pixels")
    left, top, right, bottom = bounds
    padding = 4
    return cell.crop(
        (
            max(0, left - padding),
            max(0, top - padding),
            min(cell.width, right + padding),
            min(cell.height, bottom + padding),
        )
    )


def fit_sprite(sprite: Image.Image) -> Image.Image:
    max_width = TARGET_CELL[0] - 16
    max_height = TARGET_CELL[1] - 12
    scale = min(max_width / sprite.width, max_height / sprite.height)
    size = (
        max(1, round(sprite.width * scale)),
        max(1, round(sprite.height * scale)),
    )
    return sprite.resize(size, Image.Resampling.NEAREST)


def source_cell(sheet: Image.Image, column: int, row: int) -> Image.Image:
    left = round(column * sheet.width / SOURCE_COLUMNS)
    right = round((column + 1) * sheet.width / SOURCE_COLUMNS)
    top = round(row * sheet.height / SOURCE_ROWS)
    bottom = round((row + 1) * sheet.height / SOURCE_ROWS)
    return sheet.crop((left, top, right, bottom))


def main() -> None:
    sheets = [Image.open(path).convert("RGBA") for path in SOURCE_SHEETS]
    atlas = Image.new(
        "RGBA",
        (TARGET_CELL[0] * len(FRAME_MAP), TARGET_CELL[1] * len(sheets) * SOURCE_ROWS),
        (0, 0, 0, 0),
    )

    for sheet_index, sheet in enumerate(sheets):
        for source_row in range(SOURCE_ROWS):
            target_row = sheet_index * SOURCE_ROWS + source_row
            for target_column, source_column in enumerate(FRAME_MAP):
                sprite = fit_sprite(crop_visible_sprite(source_cell(sheet, source_column, source_row)))
                x = target_column * TARGET_CELL[0] + (TARGET_CELL[0] - sprite.width) // 2
                y = target_row * TARGET_CELL[1] + TARGET_CELL[1] - sprite.height - 4
                atlas.alpha_composite(sprite, (x, y))

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(OUTPUT, optimize=True)
    print(f"Wrote {OUTPUT} ({atlas.width}x{atlas.height})")


if __name__ == "__main__":
    main()
