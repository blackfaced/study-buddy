// Dictation guides never contain the answer. Ink retains its normalized
// 600×600 coordinates so existing stroke snapshots and undo keep working.
export function renderDictationSheet(
  { stage, guides, grid, kidSvg, characterLayer },
  item,
) {
  guides.replaceChildren();
  guides.style.display = item ? "" : "none";
  stage.classList.toggle(
    "dictation-sheet",
    !!item && (item.kind === "sentence" || Array.from(item.text).length > 1),
  );
  grid.style.display = item ? "none" : "";
  kidSvg.setAttribute("preserveAspectRatio", item ? "none" : "xMidYMid meet");
  kidSvg.classList.toggle("dictation-ink", !!item);
  characterLayer.style.transform = "";
  if (!item) {
    stage.style.removeProperty("--sheet-ratio");
    return;
  }

  const count = Math.max(1, Array.from(item.text).length);
  if (item.kind === "sentence") {
    const rows = Math.max(3, Math.ceil(count / 12));
    const height = rows * 240 + 60;
    stage.style.setProperty("--sheet-ratio", String(1200 / height));
    guides.setAttribute("viewBox", `0 0 1200 ${height}`);
    for (let row = 1; row <= rows; row += 1) {
      const line = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "line",
      );
      line.setAttribute("class", "dictation-line");
      line.setAttribute("x1", "40");
      line.setAttribute("x2", "1160");
      line.setAttribute("y1", String(row * 240));
      line.setAttribute("y2", String(row * 240));
      guides.appendChild(line);
    }
    return;
  }
  const columns = Math.min(count, 3);
  const rows = Math.ceil(count / columns);
  const width = columns * 600;
  const height = rows * 600;
  stage.style.setProperty("--sheet-ratio", String(width / height));
  guides.setAttribute("viewBox", `0 0 ${width} ${height}`);
  for (let i = 0; i < count; i += 1) {
    const x = (i % columns) * 600;
    const y = Math.floor(i / columns) * 600;
    const cell = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    cell.setAttribute("class", "dictation-cell");
    cell.setAttribute("x", x);
    cell.setAttribute("y", y);
    cell.setAttribute("width", "600");
    cell.setAttribute("height", "600");
    guides.appendChild(cell);
    const cross = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path",
    );
    cross.setAttribute("d", `M ${x + 300} ${y} v 600 M ${x} ${y + 300} h 600`);
    cross.setAttribute("stroke-dasharray", "8 8");
    guides.appendChild(cross);
  }
}
