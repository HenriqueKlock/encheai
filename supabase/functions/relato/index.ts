// Relatar problema ou sugestão: guarda na tabela feedback (só o dono do projeto lê, pelo painel)
// e manda um e-mail para o dono pelo Resend. O destino e a chave ficam nos segredos do Supabase
// (RESEND_API_KEY, RELATO_PARA e, com domínio verificado, RELATO_DE); nada disso fica no repositório.
// Funciona com ou sem login (quem não consegue entrar também precisa relatar), com limite por hora.
// Até 3 prints (imagens) por relato: vão para o bucket privado `relatos` e seguem anexados no e-mail.
const ALLOWED_ORIGINS = ['https://henriqueklock.github.io', 'http://localhost:5173', 'http://localhost:4173', 'http://localhost:4190'];
const URL_ = Deno.env.get('SUPABASE_URL') ?? '';
const ANON = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

async function currentUser(req: Request): Promise<{ id: string; email: string | null } | null> {
  const auth = req.headers.get('authorization') ?? '';
  if (!/^Bearer eyJ/.test(auth)) return null;
  try {
    const r = await fetch(URL_ + '/auth/v1/user', { headers: { apikey: ANON, Authorization: auth } });
    if (!r.ok) return null;
    const u = await r.json();
    return typeof u?.id === 'string' ? { id: u.id, email: u.email ?? null } : null;
  } catch {
    return null;
  }
}

const admin = { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json' };
const MAX_PRINTS = 3, MAX_BYTES = 3 * 1024 * 1024;

interface Print { bytes: Uint8Array; type: 'image/jpeg' | 'image/png' | 'image/webp'; ext: string; b64: string }

/** Confere cada print pelo conteúdo (não pelo nome): JPEG, PNG ou WebP, até 3 MB. */
function prints(raw: unknown): Print[] | string {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_PRINTS) return 'Envie no máximo ' + MAX_PRINTS + ' imagens.';
  const out: Print[] = [];
  for (const p of raw) {
    const b64 = typeof p?.dados === 'string' ? p.dados.replace(/^data:[^,]*,/, '') : '';
    if (!b64 || b64.length > Math.ceil(MAX_BYTES * 4 / 3) + 4) return 'Imagem grande demais (máximo 3 MB).';
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); } catch { return 'Imagem inválida.'; }
    const h = bytes.subarray(0, 12);
    const isJpg = h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff;
    const isPng = h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47;
    const isWebp = String.fromCharCode(...h.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...h.subarray(8, 12)) === 'WEBP';
    if (!isJpg && !isPng && !isWebp) return 'Só dá para anexar imagens (JPG, PNG ou WebP).';
    out.push({ bytes, b64, type: isJpg ? 'image/jpeg' : isPng ? 'image/png' : 'image/webp', ext: isJpg ? 'jpg' : isPng ? 'png' : 'webp' });
  }
  return out;
}
const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+$/g, '').slice(0, n) : '');

async function recentCount(filter: string): Promise<number> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const r = await fetch(URL_ + '/rest/v1/feedback?select=id&created_at=gte.' + since + '&' + filter, { headers: { ...admin, Prefer: 'count=exact', Range: '0-0' } });
  const range = r.headers.get('content-range') ?? '';
  return Number(range.split('/')[1] ?? 0) || 0;
}

Deno.serve(async (req) => {
  const headers = cors(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });
  if (!URL_ || !SERVICE) return json(500, { error: 'Servidor sem configuração.' });

  let b: any = {};
  try { b = await req.json(); } catch { return json(400, { error: 'Corpo inválido.' }); }
  if (b?.site) return json(200, { ok: true }); // campo-isca preenchido: robô
  const kind = b?.tipo === 'sugestao' ? 'sugestao' : b?.tipo === 'problema' ? 'problema' : null;
  const message = clip(b?.mensagem, 4000).trim();
  if (!kind || message.length < 3) return json(400, { error: 'Escreva o que aconteceu ou a sua ideia.' });
  const imgs = prints(b?.prints);
  if (typeof imgs === 'string') return json(400, { error: imgs });

  const user = await currentUser(req);
  // limite: 10 por hora por conta; sem login, 20 por hora no total
  const n = await recentCount(user ? 'user_id=eq.' + user.id : 'user_id=is.null');
  if (n >= (user ? 10 : 20)) return json(429, { error: 'Muitos relatos em pouco tempo. Tente de novo mais tarde.' });

  const contact = clip(b?.contato, 120).trim() || null;
  const row = {
    user_id: user?.id ?? null, kind, message, contact,
    page: clip(b?.tela, 80) || null, app_version: clip(b?.versao, 40) || null, device: clip(b?.aparelho, 300) || null,
  };
  const ins = await fetch(URL_ + '/rest/v1/feedback', { method: 'POST', headers: { ...admin, Prefer: 'return=representation' }, body: JSON.stringify(row) });
  if (!ins.ok) {
    console.error(JSON.stringify({ event: 'relato-erro-gravar', status: ins.status }));
    return json(502, { error: 'Não deu para enviar agora. Tente de novo em instantes.' });
  }
  const saved = (await ins.json())[0];

  // prints no bucket privado
  const paths: string[] = [];
  for (const [i, img] of imgs.entries()) {
    const path = saved.id + '/' + (i + 1) + '.' + img.ext;
    const up = await fetch(URL_ + '/storage/v1/object/relatos/' + path, { method: 'POST', headers: { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': img.type, 'x-upsert': 'true' }, body: new Blob([img.bytes as BlobPart], { type: img.type }) });
    if (up.ok) paths.push(path);
    else console.error(JSON.stringify({ event: 'relato-erro-print', status: up.status }));
  }
  if (paths.length) await fetch(URL_ + '/rest/v1/feedback?id=eq.' + saved.id, { method: 'PATCH', headers: admin, body: JSON.stringify({ attachments: paths }) });

  // e-mail para o dono (se configurado)
  const key = Deno.env.get('RESEND_API_KEY');
  const to = Deno.env.get('RELATO_PARA');
  let emailed = false;
  if (key && to) {
    const replyTo = user?.email ?? (contact && /@/.test(contact) ? contact : null);
    const text = [
      (kind === 'problema' ? 'Problema' : 'Sugestão') + ' enviado pelo app',
      '',
      message,
      '',
      '— De: ' + (user?.email ?? contact ?? 'sem login, sem contato'),
      '— Tela: ' + (row.page ?? '-') + ' · versão ' + (row.app_version ?? '-'),
      '— Aparelho: ' + (row.device ?? '-'),
      '— Prints: ' + (imgs.length ? imgs.length + ' (anexados; também no Storage, bucket relatos/' + saved.id + ')' : 'nenhum'),
      '— Id: ' + saved.id,
    ].join('\n');
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: Deno.env.get('RELATO_DE') ?? 'Enche Aí <onboarding@resend.dev>',
          to: [to],
          subject: (kind === 'problema' ? '[Problema] ' : '[Sugestão] ') + message.replace(/\s+/g, ' ').slice(0, 70),
          text,
          ...(replyTo ? { reply_to: replyTo } : {}),
          ...(imgs.length ? { attachments: imgs.map((img, i) => ({ filename: 'print-' + (i + 1) + '.' + img.ext, content: img.b64 })) } : {}),
        }),
      });
      emailed = r.ok;
      if (!r.ok) console.error(JSON.stringify({ event: 'relato-erro-email', status: r.status, body: (await r.text()).slice(0, 200) }));
    } catch (e) {
      console.error(JSON.stringify({ event: 'relato-erro-email', error: String(e) }));
    }
    if (emailed) await fetch(URL_ + '/rest/v1/feedback?id=eq.' + saved.id, { method: 'PATCH', headers: admin, body: JSON.stringify({ emailed: true }) });
  }
  console.log(JSON.stringify({ event: 'relato', kind, logged: !!user, emailed, prints: paths.length }));
  return json(200, { ok: true });
});
