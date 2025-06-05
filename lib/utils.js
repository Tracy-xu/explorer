export function dedent(str) {
    const lines = str.replace(/^\n/, '').split('\n');
    const indent = lines[0].match(/^(\s*)/)?.[0].length ?? 0;
    return lines.map((line) => line.slice(indent)).join('\n');
}
