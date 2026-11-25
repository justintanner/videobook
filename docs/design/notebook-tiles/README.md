# Notebook tile state boards

The **More notebook tile states** page contains ten 800 × 600 artboards. Each specimen uses a 240 × 200 tile at notebook detail scale 1. The original page contains the anatomy, video, image, gen, post, and shared interaction boards. [Open the design canvas](https://claude.ai/artifact/KoA5a4awzVvhZppjbVyf8i#page-9dc14b2b32d0)

Open `index.html` in a browser to view the editable board sources offline. Tile states and example content live in `boards.js`, and their appearance lives in `boards.css`. Each named canvas artboard contains a full-size PNG of its corresponding HTML section. To update a board, capture that section at CSS pixel scale and fit the image to the 800 × 600 artboard at (0, 0). The published PNGs were checked against the local captures by SHA-256 after reopening the canvas.

## Comparison with Videobook

The November 25, 2026 comparison covers all 58 specimens. The application samples used the production `CellNode` and `GoalCellNode` components at commit `87795418`, rendered with the repository's React Flow, media slot and goal fixture patterns. They used the built application's stylesheets in production order. The design and application samples were measured in isolated tabs of the shared browser with a fixed tile scale. Waveforms, split frames, routes, job states, and three-clip goals used offline data.

The table reports CSS pixels. Each pair gives **board / application**. The CSV records each measured part's x, y, width, and height relative to its tile. Coordinates are rounded to 0.1 px. A match allows 0.2 px on each coordinate. The corner mark uses computed width, height, border color, and radius. The 655 comparisons contain **480 matches, 149 differences and 26 parts present on only one side**. Some one-sided parts are obscured layers, such as split frames behind a running overlay or shot rows behind expanded JSON. Measurements include content-dependent widths such as chip labels and timers. [All measurements by board, state and part](measurements.csv)

| Board | States | Measurements from the browser |
| --- | ---: | --- |
| Audio | 6 | The idle waveform is 238 × 137.8 on both sides. Both use a 240 × 156 viewBox, 4-unit bar pitch, 2 px strokes, and 0.82 / 0.26 opacity for ready / pending peaks. Both duration rails are 20.3 px high. Adding a version raises the application header from 26.2 to 32.8 px and reduces waveform height to 131.2 px. |
| Extract audio | 6 | The running overlay fills the same 238 × 137.8 body as the finished waveform. The one-source chip measures 48.8 / 51.6 wide and 26 high. The extracting flag measures 78 / 87.5 wide and 18 high. |
| Split video | 6 | Both halves measure 118.5 × 137.8 with a 1 px divider. Each caption sits 5 px from the edge with 4 × 5 px padding. A pending caption is 48 px high and a timestamped caption is 26.5 px high on both sides. The application retains these frames underneath its working and failed overlays. |
| Concat | 6 | The two-input chip measures 81.8 / 95.2 wide at the same (21, −13) origin. Both running overlays fill the body. The failed action is 24 / 28 high. |
| Splice | 6 | The two-input chip uses the same geometry as concat. The splicing flag measures 64.8 / 74.3 wide and 18 high. The full-body clock and failed overlay occupy the same bounds on both sides. |
| Prompt | 6 | The short and multiline copy begin at (23, 33.2) in a 194 px column. The long example occupies 131.9 / 113.1 px. The application clamps at six lines. Its selected corner changes to #4fb77d while the board keeps the normal green corner. |
| Character | 4 | The picker cue remains visible when routed. The 28 × 28 icon starts at y = 57.1 / 58.9. The multiple-destination chip measures 68.6 / 92.2 wide. Both are 26 high. |
| Analyze | 6 | The instruction starts at (23, 33.2). The queued and analyzing docks are 43.4 / 42.2 high. The failed dock is 74.8 / 83 high. Its action begins at (17, 131) on both sides. |
| Analysis | 6 | A five-shot result shows three rows and “+2 more” on both sides. The shot list is 194 px wide. The first row is 21.4 / 22.5 high. The expanded JSON surface begins at (9, 35.2) and measures 222 × 121.8 on both sides. |
| Goal | 6 | Resting corners are 17 × 17, purple #b9a9f2 with a 6 px radius. On failure the application switches the mark to red #ef4444 while the board keeps purple. The three planning bars round to 171, 140, and 155 px wide and are 9 px high. Both running specimens show three numbered 194 × 16.5 rows with 4 px gaps. The first row begins at y = 52 / 53.2. Both progress rails measure 194 × 3 at (23, 152). |

The goal board names its shots and describes completed rows as “Done”. The application numbers clips, displays the duration for completed rows, and names the active stage in its footer. Clock values and media artwork are illustrative. The comparison covers layout at rest, with the open JSON state measured separately.
