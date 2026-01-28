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
아래 정보를 참고하여 "본문 문구"를 3종 톤으로 작성하라.

[본문 작성 규칙 - 매우 중요]
- 본문은 반드시 "받는 분의 이름이나 호칭을 직접 부르지 말고" 시작할 것
  (예: 김OO님, 부장님, 선생님 등으로 시작 금지)
- 본문은 설명문 형태로 자연스럽게 시작할 것
  (예: "오랜 시간 동안 보여주신 헌신과 책임감에 깊은 감사를 전합니다."처럼)
- 각 본문은 한국어 기준 공백 제외 "120~140자" 분량으로 작성
- 너무 짧게 작성하지 말 것 (공백 제외 120자 미만 금지)
- 의미는 유지하되, 톤만 다르게

[톤 정의]
- polite: 격식 있고 공식적인 어투
- emotional: 따뜻하고 진심이 느껴지는 어투
- witty: 산뜻하고 센스 있는 어투 (가볍지만 예의 유지)

[서명 규칙]
- "올림" 또는 "드림" 중 하나를 무작위로 선택해 sign에 담아라

[절대 금지]
- 머리말, 제목, 설명문, 마크다운, 코드블록
- JSON 외 텍스트 출력

[입력 정보]
상황(occasion): ${occasion}   (참고용, 문체 결정에만 사용)
받는 분: ${to}
핵심 메시지 요약: ${message}
날짜: ${date || "미기재"}
보내는 분: ${from || "미기재"}

[출력 JSON 형식 - 정확히 이 키만 사용]
{
  "polite": "공백 제외 120~140자 본문",
  "emotional": "공백 제외 120~140자 본문",
  "witty": "공백 제외 120~140자 본문",
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
