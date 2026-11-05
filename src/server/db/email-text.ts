/** Compile a shared text template into SQLite concatenation. Only backend-owned
 * SQL expressions belong in values; recipient data stays in columns/bindings.
 */
export function emailTextSql(template: string, values: Record<string, string>) {
  return template
    .split(/(\{\{\w+\}\})/g)
    .map((part) => {
      const match = /^\{\{(\w+)\}\}$/.exec(part);
      if (!match) return `'${part.replaceAll("'", "''")}'`;
      if (!Object.hasOwn(values, match[1]))
        throw new Error(`Missing email SQL expression: ${match[1]}`);
      return `(${values[match[1]]})`;
    })
    .join(" || ");
}

/** Escape recipient values before substituting them into an HTML template. */
export function emailHtmlSql(template: string, values: Record<string, string>) {
  return emailTextSql(
    template,
    Object.fromEntries(
      Object.entries(values).map(([key, expression]) => [
        key,
        `replace(replace(replace(replace(replace((${expression}),'&','&amp;'),'<','&lt;'),'>','&gt;'),'"','&quot;'),char(39),'&#39;')`,
      ]),
    ),
  );
}
