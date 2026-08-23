# Pixel Agent Atlas v1

The runtime atlas is generated from the three alpha source sheets:

- `team-a`: Director, Operations, Brand
- `team-b`: Growth, Content, Creative
- `team-c`: Customer, Finance, Technology

Run `python scripts/build_pixel_agent_atlas.py` from the project root after
changing a source sheet.

The generated atlas is `public/agents/pixel-agent-atlas-v1.png`.

Each cell is 128 x 160 pixels. Columns are:

1. down A
2. down B
3. left A
4. left B
5. up A
6. up B
7. right A
8. right B

Rows follow the profile order listed above.
