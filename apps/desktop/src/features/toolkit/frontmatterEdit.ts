/**
 * Sets, replaces or removes one scalar key in a markdown file's YAML frontmatter and
 * leaves every other line untouched. A `null` value removes the key.
 */
export function setFrontmatterField(content: string, key: string, value: string | null): string {
  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const hasFrontmatter = lines[0]?.trimEnd() === '---';
  const close = hasFrontmatter ? lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---') : -1;
  const rendered = value === null ? null : `${key}: ${value}`;
  if (close === -1) {
    return rendered === null ? content : `---${lineEnding}${rendered}${lineEnding}---${lineEnding}${content}`;
  }
  const existing = lines.findIndex((line, index) => index > 0 && index < close && line.startsWith(`${key}:`));
  if (existing !== -1) {
    if (rendered === null) {
      lines.splice(existing, 1);
    } else {
      lines[existing] = rendered;
    }
  } else if (rendered !== null) {
    lines.splice(close, 0, rendered);
  }
  return lines.join(lineEnding);
}
