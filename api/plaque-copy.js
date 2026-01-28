export default async function handler(req, res) {
  // CORS
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

    // ✅ 프롬프트 강화: 코드블록 금지 / JSON만
    const prompt = `
너는 감사패/상패 문구 전문 카피라이터다.
아래 정보를 바탕으로 의미는 동일하게 유지하되, 톤만 다른 문구 3종을 작성하라.

[절대 규칙]
- 설명/문장/머리말/꼬리말 금지
- 마크다운 금지 (특히 \`\`\`json 같은 코드블록 금지)
- 반드시 아래 형식의 "순수 JSON"만 출력

[톤]
- polite: 격식 있고 공식적인 어투
- emotional: 따뜻하고 진심이 느껴지는 어투
- witty: 산뜻하고 센스 있는 어투(예의 유지)

[입력]
상황: ${occasion}
받는 분: ${to}
핵심 메시지: ${message}
증정일: ${date || "미기재"}
보내는 분: ${from || "미기재"}

[출력 JSON 형식(이대로 키 유지)]
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
        // ✅ 가능하면 JSON 출력 모드 강제 (지원되는 계정/모델이면 더 안정적)
        response_format: { type: "json_object" },
        input: prompt,
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(500).json({ error: "OpenAI 호출 실패", detail });
    }

    const data = await r.json();

    // Responses API에서 텍스트 뽑기
    const rawText =
      data?.output?.[0]?.content?.find?.((c) => c.type === "output_text")?.text ??
      data?.output_text ??
      "";

    // ✅ 1차: 코드블록 제거
    let cleaned = rawText.trim();
    cleaned = cleaned
      .replace(/^```(?:json)?\s*/i, "")  // 시작 ```json 제거
      .replace(/```$/i, "")              // 끝 ``` 제거
      .trim();

    // ✅ 2차: 그래도 앞뒤에 잡텍스트가 있으면 { ... }만 추출
    if (!(cleaned.startsWith("{") && cleaned.endsWith("}"))) {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) cleaned = m[0];
    }

    // ✅ 최종 파싱
    const parsed = JSON.parse(cleaned);

    // 키가 없으면(가끔 모델이 다르게 뱉는 경우) 에러 처리
    if (!parsed?.polite || !parsed?.emotional || !parsed?.witty) {
      return res.status(500).json({
        error: "응답 JSON 키가 예상과 다릅니다.",
        detail: cleaned,
      });
    }

    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ error: "서버 오류", detail: String(e) });
  }
}
