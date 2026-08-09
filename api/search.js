// 体育家园 AI 搜索后端（Vercel: /api/search）
// 流程：问题翻译 -> Crossref 检索期刊文献 -> DeepSeek 生成中文精华+建议 -> 返回前端格式
const DS_BASE = (process.env.AI_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
const DS_MODEL = process.env.AI_MODEL || "deepseek-chat";
const DS_KEY = process.env.DEEPSEEK_API_KEY || "";
const CROSSREF = "https://api.crossref.org/works?rows=10&select=title,author,container-title,published,DOI,abstract&query=";
const SPORT_FRAGS = [
  "british journal of sports medicine", "sports medicine", "medicine and science in sports",
  "strength and conditioning", "journal of applied physiology", "journal of sports sciences",
  "european journal of sport science", "scandinavian journal of medicine", "sports physiology",
  "sport and health science", "biology of sport", "human kinetics", "athletic training",
  "science and medicine in sport", "sports and active living", "applied physiology", "kinesiology",
  "biomechanics", "sports (basel", "pediatric exercise", "sports nutrition",
  "journal of sport rehabilitation", "sport sciences for health", "sports health",
  "physical activity and health"
];

async function fetchJson(url, timeout = 8000, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, ...(opts || {}) });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    clearTimeout(t);
    return null;
  }
}

async function translate(text, sl = "zh-CN", tl = "en") {
  if (!text) return "";
  const d = await fetchJson(
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=" + sl + "&tl=" + tl + "&dt=t&q=" + encodeURIComponent(text),
    6000
  );
  if (!d || !d[0]) return "";
  return ((d[0] || []).map(s => (s && s[0]) || "")).join("");
}

async function dsChat(messages) {
  if (!DS_KEY) return null;
  const d = await fetchJson(DS_BASE + "/chat/completions", 45000, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + DS_KEY },
    body: JSON.stringify({ model: DS_MODEL, messages, temperature: 0.3, max_tokens: 1800 })
  });
  if (!d || !d.choices || !d.choices[0]) return null;
  return {
    content: (d.choices[0].message && d.choices[0].message.content) || null,
    usage: d.usage || null
  };
}

async function crossrefPapers(enQ) {
  const data = await fetchJson(CROSSREF + encodeURIComponent(enQ), 10000);
  if (!data || !data.message || !data.message.items) return [];
  const items = data.message.items || [];
  const papers = items.map(it => {
    const title = (it.title && it.title[0]) || "";
    const journal = (it["container-title"] && it["container-title"][0]) || "";
    let year = "";
    for (const k of ["published-print", "published-online", "published"]) {
      if (it[k] && it[k]["date-parts"] && it[k]["date-parts"][0] && it[k]["date-parts"][0][0]) {
        year = String(it[k]["date-parts"][0][0]);
        break;
      }
    }
    const authors = ((it.author || []).slice(0, 4).map(a => ((a.given || "") + " " + (a.family || "")).trim()).filter(Boolean)).join(", ");
    const abs = (it.abstract || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 900);
    return { title, journal, year, authors, doi: it.DOI || "", abstract: abs, evidence: "", oa: null };
  }).filter(p => p.title);
  const isSport = p => {
    const j = (p.journal || "").toLowerCase();
    return SPORT_FRAGS.some(f => j.includes(f));
  };
  papers.sort((a, b) => (isSport(b) ? 1 : 0) - (isSport(a) ? 1 : 0));
  return papers.slice(0, 6);
}

function parseLLMJson(text) {
  if (!text) return null;
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(s); } catch (e) {}
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  const q = (req.method === "POST" && req.body && req.body.q) || (req.query && req.query.q) || "";
  if (!q || !String(q).trim()) return res.status(400).json({ engine: "error", query: "" });
  const query = String(q).trim();
  const lang = (req.method === "POST" && req.body && req.body.lang) || (req.query && req.query.lang) || "zh";
  const isEn = lang === "en";

  try {
    const enQ = (await translate(query, "zh-CN", "en")) || query;
    const papers = await crossrefPapers(enQ);
    if (!isEn) {
      const tzList = await Promise.all(papers.map(p => translate(p.title, "auto", "zh-CN")));
      const azList = await Promise.all(papers.map(p => translate(p.abstract.slice(0, 700), "auto", "zh-CN")));
      papers.forEach((p, i) => { p.title_zh = tzList[i]; p.abstract_zh = azList[i]; });
    }

    const paperBlock = papers.length
      ? papers.map((p, i) => (i + 1) + ". [" + (p.journal || "期刊") + " " + p.year + "] " + (p.title_zh || p.title)).join("\n")
      : "（未检索到相关期刊文献，请基于你的运动科学知识回答，并明确标注为一般性建议）";

    const noPapers = isEn ? "No matching papers found; answer based on sports science knowledge and mark as general advice." : "（未检索到相关期刊文献，请基于你的运动科学知识回答，并明确标注为一般性建议）";
    const paperBlockFinal = papers.length ? paperBlock : noPapers;

    const sys = isEn
      ? "You are a rigorous sports science expert familiar with top global journals (Nature, Science, BJSM, Sports Medicine, MSSE, etc.). Answer in English: give a direct evidence-based conclusion, actionable advice, never fabricate papers, never exaggerate effects."
      : "你是一位严谨的运动科学专家，熟悉全球顶级体育期刊（Nature、Science、BJSM、Sports Medicine、MSSE 等）的研究证据。回答必须：直接给出结论、有证据支撑、给出可执行建议、不虚构文献、不夸大效果。";
    const userMsg = isEn
      ? "User question: " + query + "\n\nRelated journal papers found:\n" + paperBlockFinal +
        "\n\nStrictly return ONLY JSON (no extra text):\n" +
        '{"essence":"2-3 sentences answering directly with an evidence-based conclusion (in English)","advice":[{"text":"specific actionable advice (in English)","source":"Journal · Year"},3-5 items]}'
      : "用户问题：" + query + "\n\n检索到的相关期刊文献：\n" + paperBlockFinal +
        "\n\n请严格只返回 JSON（不要任何多余文字）：\n" +
        '{"essence":"2-3句话直接回答并给出证据结论","advice":[{"text":"具体可执行建议","source":"期刊名 · 年份"}，共3-5条]}';

    const ds = await dsChat([{ role: "system", content: sys }, { role: "user", content: userMsg }]);
    const llmText = ds ? ds.content : null;
    const parsed = parseLLMJson(llmText);
    if (!parsed) return res.status(200).json({ engine: "error", query });

    return res.status(200).json({
      engine: "llm",
      query,
      essence: parsed.essence || (isEn ? "Analysis completed with global top journal database and AI." : "已结合全球顶级期刊数据库与 AI 综合分析完成。"),
      advice: (parsed.advice || []).map(a => ({ text: a.text || "", source: a.source || "" })),
      papers,
      mode_note: "DeepSeek AI · 期刊数据库综合分析",
      usage: ds ? ds.usage : null
    });
  } catch (e) {
    return res.status(200).json({ engine: "error", query });
  }
}
