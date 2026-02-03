export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const {
      occasion, to, message, date, from,
      mode, tone, avoid_text
    } = req.body || {};

    if (!occasion || !to || !message) {
      return res.status(400).json({ error: "occasion/to/message는 필수입니다." });
    }

    const isToneOne = mode === "tone_one";

    // ✅ 톤 정의(추가 생성용)
    const toneDef = (t) => {
      if (t === "polite") return "격식 있고 헌정문에 가까운 어투";
      if (t === "emotional") return "따뜻하지만 가볍지 않은 어투";
      return "산뜻하고 센스 있는 어투 (가볍지만 예의 유지)";
    };

    // ✅ (추가) 선행공백 제거
    const stripLeading = (s) => (s ?? "").replace(/^[\s\uFEFF\xA0]+/, "");

    // ✅ (추가) 영문/외국어 감지
    function hasForeign(s) {
      if (!s) return false;

      // 1) 알파벳이 있으면 무조건 외국어로 판단
      if (/[A-Za-z]/.test(s)) return true;

      // 2) 허용 문자(한글/자모/숫자/공백/기본문장부호) 외가 있으면 외국어로 판단
      //    - 영어 외에도, 라틴확장/키릴/중국어/일본어/이모지 등이 걸러짐
      const allowed = /^[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F0-9\s.,!?'"()\-[\]{}~·…:;/%&+=<>@#^_|\\\n\r]+$/;
      return !allowed.test(s);
    }

    // ✅ OpenAI 호출 함수(재시도용)
    async function callOpenAI(prompt) {
      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          input: prompt,
          text: { format: { type: "json_object" } }
        }),
      });

      if (!r.ok) {
        const detail = await r.text();
        throw new Error(detail);
      }
      return await r.json();
    }

    // ✅ 응답 텍스트(JSON) 파싱 함수
    function parseJsonFromResponsesAPI(data) {
      const rawText =
        data?.output?.[0]?.content?.find?.((c) => c.type === "output_text")?.text ??
        data?.output_text ??
        "";

      let cleaned = rawText.trim();
      cleaned = cleaned
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```$/i, "")
        .trim();

      if (!(cleaned.startsWith("{") && cleaned.endsWith("}"))) {
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) cleaned = m[0];
      }

      return { cleaned, parsed: JSON.parse(cleaned) };
    }

    // =========================
    // 프롬프트 구성(너가 준 그대로)
    // =========================
    const prompt = isToneOne ? `
너는 감사패/상패 문구를 전문으로 작성하는 한국어 카피라이터다.
아래의 '상황'은 문체와 의미를 결정하는 핵심 조건이다.
모든 내용은 한국어로만 작성하고 외래어 작성은 무조건 금지

[상황 해석 규칙 - 매우 중요]
- 상황이 "생신/환갑/칠순"인 경우:
  - 단순한 생일 축하 문구처럼 쓰지 말 것
  - 반드시 아래 의미 중 2가지 이상을 본문에 반영할 것
    1) 긴 세월과 인생의 시간
    2) 가족과 주변에 남긴 삶의 흔적
    3) 존경, 헌정, 감사의 감정
    4) 앞으로의 축복은 '새 출발'이 아닌 '평안과 건강'의 의미
  - 가볍거나 캐주얼한 표현 금지
  - 청춘/새 출발/모험 같은 단어 사용 금지

- 상황이 "퇴직/정년"인 경우: 수고, 헌신, 책임, 조직 기여 중심
- 상황이 "공로/감사"인 경우: 성과보다 태도, 영향력, 신뢰 강조
- 상황이 "기념/창립"인 경우: 시간의 축적, 성장, 공동의 여정 강조

[본문 작성 규칙]
- 본문은 반드시 "받는 분의 이름이나 호칭을 부르지 말고" 시작할 것
- 본문은 설명문 형태로 자연스럽게 시작할 것
- 본문은 상황을 이해하고 작성할 것
- 본문은 호칭이나 이름으로 시작하지 말 것
- 본문은 한국어 기준 220~240자 분량으로 작성 (220자 미만 금지)
- 본문은 날짜, 보내는 분을 적지말 것 (특히, 본문 끝에 날짜나 보내는 분이 있다면 삭제할 것)

[추가 생성 규칙 - 매우 중요]
- 이번 요청은 기존 문구의 "추가 버전"이다.
- 아래 문장과 표현/구성/문장 시작부가 겹치지 않게 완전히 새롭게 작성하라:
${avoid_text || "(없음)"}

[톤]
- 이번 문장은 반드시 아래 톤을 엄격히 따를 것:
${toneDef(tone)}

[절대 금지]
- 머리말, 제목, 설명, 마크다운, 코드블록
- JSON 외 텍스트 출력

[언어 규칙 - 최상위]
- 출력 본문은 100% 한국어로만 구성한다.
- 부득이하게 약어/영문이 필요한 경우에도 한글로 풀어서 쓰고, 알파벳 사용 금지.
- 입력(핵심 메시지 요약)에 숫자가 포함되면, 그 숫자는 본문에 반드시 아라비아 숫자(0-9)로 그대로 포함할 것. (예: 30주년 → "30주년")
- 숫자를 한글로 풀어쓰지 말 것. (예: "삼십", "서른" 금지)

[입력 정보]
상황: ${occasion}
받는 분: ${to}
핵심 메시지 요약: ${message}
날짜: ${date || "미기재"}
보내는 분: ${from || "미기재"}

[출력 JSON 형식]
{
  "body": "220~240자 본문"
}
`.trim()
: `
너는 감사패/상패 문구를 전문으로 작성하는 한국어 카피라이터다.
아래의 '상황'은 문체와 의미를 결정하는 핵심 조건이다.
모든 내용은 한국어로만 작성하고 외래어 작성은 무조건 금지

[상황 해석 규칙 - 매우 중요]
- 상황이 "생신/환갑/칠순"인 경우:
  - 단순한 생일 축하 문구처럼 쓰지 말 것
  - 반드시 아래 의미 중 2가지 이상을 본문에 반영할 것
    1) 긴 세월과 인생의 시간
    2) 가족과 주변에 남긴 삶의 흔적
    3) 존경, 헌정, 감사의 감정
    4) 앞으로의 축복은 '새 출발'이 아닌 '평안과 건강'의 의미
  - 가볍거나 캐주얼한 표현 금지
  - 청춘/새 출발/모험 같은 단어 사용 금지

- 상황이 "퇴직/정년"인 경우: 수고, 헌신, 책임, 조직 기여 중심
- 상황이 "공로/감사"인 경우: 성과보다 태도, 영향력, 신뢰 강조
- 상황이 "기념/창립"인 경우: 시간의 축적, 성장, 공동의 여정 강조

[본문 작성 규칙]
- 본문은 반드시 "받는 분의 이름이나 호칭을 부르지 말고" 시작할 것
- 본문은 설명문 형태로 자연스럽게 시작할 것
- 본문은 상황을 이해하고 작성할 것
- 각 본문은 한국어 기준 220~240자 분량으로 작성 (220자 미만 금지)
- 의미는 유지하되 톤만 다르게
- 받는 분의 이름이나 호칭을 써야한다면 "귀하" 로 넣을 것

[톤 정의]
- polite: 격식 있고 헌정문에 가까운 어투
- emotional: 따뜻하지만 가볍지 않은 어투
- witty: 산뜻하고 센스 있는 어투 (가볍지만 예의 유지)

[서명 규칙]
- "올림" 또는 "드림" 중 하나를 무작위로 선택해 sign에 담아라

[절대 금지]
- 머리말, 제목, 설명, 마크다운, 코드블록
- JSON 외 텍스트 출력

[언어 규칙 - 최상위]
- 출력 본문은 100% 한국어로만 구성한다.
- 영문 알파벳(A-Z, a-z), 숫자+영문 조합, 외국어(한글이 아닌 문자)가 1글자라도 포함되면 즉시 실패다.
- 부득이하게 약어/영문이 필요한 경우에도 한글로 풀어서 쓰고, 알파벳 사용 금지.

[입력 정보]
상황: ${occasion}
받는 분: ${to}
핵심 메시지 요약: ${message}
날짜: ${date || "미기재"}
보내는 분: ${from || "미기재"}

[출력 JSON 형식]
{
  "polite": "220~240자 본문",
  "emotional": "220~240자 본문",
  "witty": "220~240자 본문",
  "sign": "올림 또는 드림"
}
`.trim();

    // =========================
    // ✅ 1~2회 재시도 포함 호출
    // =========================
    const MAX_TRIES = 3; // 최초 1 + 재시도 2 = 총 3번
    let lastCleaned = "";
    let parsed = null;

    for (let i = 1; i <= MAX_TRIES; i++) {
      const extraWarn = i === 1 ? "" : `

[재시도 경고 - 매우 중요]
- 이전 출력에 영문/외국어가 포함되어 실패했다.
- 이번 출력은 한글 외 문자가 1글자라도 포함되면 즉시 실패다.
- 반드시 100% 한글만 사용해서 다시 작성하라.
`;

      const data = await callOpenAI(prompt + extraWarn);
      const result = parseJsonFromResponsesAPI(data);
      lastCleaned = result.cleaned;
      parsed = result.parsed;

      // 기본 키 검증 + 공백 정리
      if (isToneOne) {
        if (!parsed?.body) continue;
        parsed.body = stripLeading(parsed.body);
        const bad = hasForeign(parsed.body);
        if (!bad) break; // ✅ 통과
      } else {
        if (!parsed?.polite || !parsed?.emotional || !parsed?.witty) continue;
        parsed.polite = stripLeading(parsed.polite);
        parsed.emotional = stripLeading(parsed.emotional);
        parsed.witty = stripLeading(parsed.witty);
        parsed.sign = stripLeading(parsed.sign || "");
        const bad = [parsed.polite, parsed.emotional, parsed.witty].some(hasForeign);
        if (!bad) break; // ✅ 통과
      }

      // 루프가 끝까지 가면 아래에서 에러 처리
    }

    // =========================
    // 최종 검증 (재시도 후에도 실패면 에러)
    // =========================
    if (isToneOne) {
      if (!parsed?.body) {
        return res.status(500).json({ error: "응답 JSON 키가 예상과 다릅니다.", detail: lastCleaned });
      }
      if (hasForeign(parsed.body)) {
        return res.status(500).json({
          error: "외국어/영문 포함으로 생성 실패(재시도 후)",
          detail: parsed.body
        });
      }
      return res.status(200).json(parsed);
    }

    if (!parsed?.polite || !parsed?.emotional || !parsed?.witty) {
      return res.status(500).json({ error: "응답 JSON 키가 예상과 다릅니다.", detail: lastCleaned });
    }

    if ([parsed.polite, parsed.emotional, parsed.witty].some(hasForeign)) {
      return res.status(500).json({
        error: "외국어/영문 포함으로 생성 실패(재시도 후)",
        detail: parsed
      });
    }

    return res.status(200).json(parsed);

  } catch (e) {
    return res.status(500).json({ error: "서버 오류", detail: String(e) });
  }
}
