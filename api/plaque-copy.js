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
아래 정보를 바탕으로 "본문 문구"를 3종 톤으로 작성하라.

[핵심 조건]
- 각 본문은 한국어로 "120자 내외"(대략 100~140자 범위)로 작성
- 공백/줄바꿈 포함해도 괜찮지만, 문장은 자연스럽게
- 의미는 유지하되 톤만 다르게
- "올림" 또는 "드림" 중 하나를 무작위로 선택해 sign에 담아라

[절대 규칙]
- 설명/머리말/꼬리말 금지
- 마크다운 금지 (코드블록 금지)
- 반드시 순수 JSON만 출력

[입력]
상황(occasion): ${occasion}  (참고용: 상황에 어울리게 작성)
받는 분: ${to}
핵심 메시지: ${message}
날짜: ${date || "미기재"}
보내는 분: ${from || "미기재"}

[출력]
아래 JSON 키를 정확히 지켜라:
{
  "polite": "120자 내외 본문",
  "emotional": "120자 내외 본문",
  "witty": "120자 내외 본문",
  "sign": "올림 또는 드림"
}
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
  text: {
    format: { type: "json_object" }
  }
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
