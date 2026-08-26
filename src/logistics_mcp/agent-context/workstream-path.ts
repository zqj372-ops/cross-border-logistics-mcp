const uriSchemePattern = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const varFoldersPattern = /(?:^|[\\/])(?:private[\\/])?var[\\/]folders(?:[\\/]|$)/iu;

export function isSafeRepositoryRelativeWorkstreamPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:/u.test(path) ||
    path.startsWith("~") ||
    uriSchemePattern.test(path) ||
    path.includes("\0") ||
    varFoldersPattern.test(path)
  ) {
    return false;
  }

  return !path.split(/[\\/]/u).some((component) => {
    const normalized = component.toLowerCase();
    return (
      normalized === ".." ||
      normalized === "." ||
      normalized === "tmp" ||
      normalized === "temp" ||
      normalized === "~"
    );
  });
}
