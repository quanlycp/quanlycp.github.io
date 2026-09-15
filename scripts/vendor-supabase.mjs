// Cố định SDK và lưu cùng website để khởi động ngoại tuyến không phụ thuộc CDN.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const version = '2.116.0';
const base = `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${version}`;
const destination = new URL('../js/vendor/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const [remote, local] of [['dist/umd/supabase.js', 'supabase.js'], ['LICENSE', 'SUPABASE-LICENSE']]) {
  const response = await fetch(`${base}/${remote}`);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const source = await response.text();
  const content = local.endsWith('.js') ? `// @supabase/supabase-js ${version}; MIT; see SUPABASE-LICENSE.\n${source}\nexport const createClient = supabase.createClient;\n` : source;
  await writeFile(new URL(local, destination), content);
  console.log(local, createHash('sha256').update(content).digest('hex'));
}
