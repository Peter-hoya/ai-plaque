export default async function handler(req, res) {
  // CORS (아임웹에서 호출 가능)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { occasion, to, message, date, from } = req.body || {};
    if (!occasion || !to || !message) {
      return res.status(400).json({ error: "occasion/to/message는 필수입니다." });
    }

    const prompt = `
너는 감사패/상패 문구 전문 카피라이터다.
아래 정보를 바탕으로 "의미는 동일"하게 유지하되, 톤만 다른 문구 3종을 작성하라.

[톤]
- polite: 가장 격식 있고 공식적인 어투
- emotional: 따뜻하고 진심이 느껴지는 어투
- witty: 산뜻하고 센스 있는 어투(예의 유지)

[입력]
상황: ${occasion}
받는 분: ${to}
핵심 메시지: ${message}
증정일: ${date || "미기재"}
보내는 분: ${from || "미기재"}

[출력]
반드시 JSON만 출력:
{"polite":"...","emotional":"...","witty":"..."}
`.trim();

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: prompt,
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(500).json({ error: "OpenAI 호출 실패", detail });
    }

    const data = await r.json();

    // Responses API에서 텍스트 뽑기 (케이스 대응)
    const text =
      data?.output?.[0]?.content?.find?.(c => c.type === "output_text")?.text
      ?? data?.output_text;

    const parsed = JSON.parse(text);
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ error: "서버 오류", detail: String(e) });
  }
}
