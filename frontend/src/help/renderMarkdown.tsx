import type { ReactNode } from "react";

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const src = text;
  const re =
    /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(src))) {
    if (match.index > last) {
      nodes.push(src.slice(last, match.index));
    }
    if (match[2]) {
      nodes.push(
        <img
          key={`img-${key++}`}
          src={match[2]}
          alt={match[1]}
          className="help-figure"
        />
      );
    } else if (match[4]) {
      const href = match[4];
      const label = match[3];
      if (href.endsWith(".md")) {
        nodes.push(<span key={`doc-${key++}`}>{label}</span>);
      } else {
        nodes.push(
          <a key={`a-${key++}`} href={href} target="_blank" rel="noreferrer">
            {label}
          </a>
        );
      }
    } else if (match[5]) {
      nodes.push(<strong key={`b-${key++}`}>{match[5]}</strong>);
    } else if (match[6]) {
      nodes.push(<code key={`c-${key++}`}>{match[6]}</code>);
    }
    last = match.index + match[0].length;
  }
  if (last < src.length) nodes.push(src.slice(last));
  return nodes;
}

function splitRow(line: string) {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isDivider(line: string) {
  return /^\|?\s*:?-{3,}/.test(line);
}

export function renderMarkdown(markdown: string): ReactNode[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (line.startsWith("# ")) {
      out.push(<h1 key={key++}>{inline(line.slice(2))}</h1>);
      i += 1;
      continue;
    }
    if (line.startsWith("## ")) {
      out.push(<h2 key={key++}>{inline(line.slice(3))}</h2>);
      i += 1;
      continue;
    }
    if (line.startsWith("### ")) {
      out.push(<h3 key={key++}>{inline(line.slice(4))}</h3>);
      i += 1;
      continue;
    }
    if (line.trim() === "---") {
      out.push(<hr key={key++} />);
      i += 1;
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        if (!isDivider(lines[i])) rows.push(splitRow(lines[i]));
        i += 1;
      }
      if (rows.length) {
        const head = rows[0];
        const body = rows.slice(1);
        out.push(
          <div key={key++} className="help-table-wrap">
            <table className="help-table">
              <thead>
                <tr>
                  {head.map((cell, idx) => (
                    <th key={idx}>{inline(cell)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, idx) => (
                      <td key={idx}>{inline(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      continue;
    }
    if (/^\d+\.\s/.test(line) || line.startsWith("- ")) {
      const ordered = /^\d+\.\s/.test(line);
      const items: string[] = [];
      while (
        i < lines.length &&
        (ordered ? /^\d+\.\s/.test(lines[i]) : lines[i].startsWith("- "))
      ) {
        items.push(lines[i].replace(ordered ? /^\d+\.\s/ : /^-\s/, ""));
        i += 1;
      }
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={key++}>
          {items.map((item, idx) => (
            <li key={idx}>{inline(item)}</li>
          ))}
        </List>
      );
      continue;
    }
    out.push(<p key={key++}>{inline(line)}</p>);
    i += 1;
  }
  return out;
}
