// 体育家园 AI 服务 · 健康检查（Vercel: /api/health）
export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  res.status(200).json({ ok: true, service: "sportlens-ai", ts: Date.now() });
}
