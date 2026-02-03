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

    // ✅ 톤 정의
    const toneDef = (t) => {
      if (t === "polite") return "격식 있고 헌정문에 가까운 어투";
      if (t === "emotional") return "따뜻하지만 가볍지 않은 어투";
      return "산뜻하고 센스 있는 어투 (가볍지만 예의 유지)";
    };

    // ✅ 선행공백 제거
    const stripLeading = (s) => (s ?? "").replace(/^[\s\uFEFF\xA0]+/, "");

    // ✅ (추가) 보내는 사람/날짜 제거 후처리 함수
    // AI가 실수로 본문 끝에 'OOO 드림'이나 날짜를 넣었을 경우 강제로 자릅니다.
    const cleanTail = (text) => {
      if (!text) return "";
      let cleaned = text;

      // 1. 보내는 사람 이름이 끝에 있다면 제거 (예: "마케팅팀 드림", "마케팅팀 올림", "마케팅팀")
      if (from) {
        // 특수문자 이스케이프 처리
        const safeFrom = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 정규식: (공백)(보내는사람)(공백?)(드림|올림|배상)?(마침표?)(끝)
        const fromRegex = new RegExp(`\\s*${safeFrom}\\s*(드림|올림|배상)?\\.?$`);
        cleaned = cleaned.replace(fromRegex, "");
      }

      // 2. 날짜 패턴이 끝에 있다면 제거 (예: 2024.05.21, 2024년 5월 21일)
      const dateRegex = /\s*\d{4}[.\-년]\s*\d{1,2}[.\-월]\s*\d{1,2}[일]?\.?$/;
      cleaned = cleaned.replace(dateRegex, "");
      
      return cleaned.trim();
    };


    // ✅ 영문/외국어 감지
    function hasForeign(s) {
      if (!s) return false;
      if (/[A-Za-z]/.test(s)) return true;
      const allowed = /^[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F0-9\s.,!?'"()\-[\]{}~·…:;/%&+=<>@#^_|\\\n\r]+$/;
      return !allowed.test(s);
    }

    // ✅ OpenAI 호출 함수
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

    // ✅ JSON 파싱
    function parseJsonFromResponsesAPI(data) {
      const rawText =
        data?.output?.[0]?.content?.find?.((c) => c.type === "output_text")?.text ??
        data?.output_text ??
        "";

      let cleaned = rawText.trim()
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
    // ✅ 프롬프트 수정 (날짜/서명 금지 강화)
    // =========================
    const commonRules = `
[상황 해석 규칙 - 매우 중요]
- 상황이 "생신/환갑/칠순"인 경우:
  - 단순한 생일 축하 문구처럼 쓰지 말 것
  - 반드시 아래 의미 중 2가지 이상을 본문에 반영할 것
    1) 긴 세월과 인생의 시간
    2) 가족과 주변에 남긴 삶의 흔적
    3) 존경, 헌정, 감사의 감정
    4) 앞으로의 축복은 '새 출발'이 아닌 '평안과 건강'의 의미
  - 가볍거나 캐주얼한 표현 금지

- 상황이 "퇴직/정년"인 경우: 수고, 헌신, 책임, 조직 기여 중심
- 상황이 "공로/감사"인 경우: 성과보다 태도, 영향력, 신뢰 강조
- 상황이 "기념/창립"인 경우: 시간의 축적, 성장, 공동의 여정 강조

[본문 작성 규칙 - 엄격 준수]
1. 본문은 "받는 분의 이름이나 호칭"으로 시작하지 말고 바로 내용으로 시작할 것
2. 설명문 형태로 자연스럽게 시작할 것.
3. 본문에 받는 분의 이름이나 호칭을 사용할 경우 "귀하"로 표현할 것
4. 본문 길이는 한국어 기준 220~240자 (220자 미만 금지)
5. **[중요] 본문 마지막에 '날짜'나 '보내는 사람(서명)'을 절대 적지 말 것.**
   - 이유: 시스템이 디자인 레이아웃 하단에 별도로 날짜와 서명을 삽입합니다.
   - 본문에 포함하면 이중으로 표기되므로 절대 금지합니다.
   - 예시: "...감사합니다." (O) / "...감사합니다. 2024년 5월..." (X)

[절대 금지]
- 머리말, 제목, 설명, 마크다운, 코드블록
- JSON 외 텍스트 출력
- **본문 내에 날짜(${date || "날짜"}), 보내는 분(${from || "보내는 분"}) 언급 금지**
`;

    const prompt = isToneOne ? `
너는 감사패/상패 문구를 전문으로 작성하는 한국어 카피라이터다.
아래의 '상황'은 문체와 의미를 결정하는 핵심 조건이다.
모든 내용은 한국어로만 작성하고 외래어 작성은 무조건 금지.

${commonRules}

[추가 생성 규칙]
- 이번 요청은 기존 문구의 "추가 버전"이다.
- 아래 내용과 겹치지 않게 작성하라:
${avoid_text || "(없음)"}

[톤]
- ${toneDef(tone)}

[입력 정보]
상황: ${occasion}
받는 분: ${to}
핵심 메시지 요약: ${message}
(참고용 메타데이터 - 본문에 포함 금지)
날짜: ${date || "미기재"}
보내는 분: ${from || "미기재"}

[출력 JSON 형식]
{
  "body": "본문 내용"
}
`.trim()
: `
너는 감사패/상패 문구를 전문으로 작성하는 한국어 카피라이터다.
아래의 '상황'은 문체와 의미를 결정하는 핵심 조건이다.
모든 내용은 한국어로만 작성하고 외래어 작성은 무조건 금지.

${commonRules}

[톤 정의]
- polite: 격식 있고 헌정문에 가까운 어투
- emotional: 따뜻하지만 가볍지 않은 어투
- witty: 산뜻하고 센스 있는 어투 (가볍지만 예의 유지)

[서명 규칙]
- "올림" 또는 "드림" 중 하나를 무작위로 선택해 sign 필드에만 담아라.
- **본문에는 절대 포함하지 마라.**

[입력 정보]
상황: ${occasion}
받는 분: ${to}
핵심 메시지 요약: ${message}
(참고용 메타데이터 - 본문에 포함 금지)
날짜: ${date || "미기재"}
보내는 분: ${from || "미기재"}

[출력 JSON 형식]
{
  "polite": "본문",
  "emotional": "본문",
  "witty": "본문",
  "sign": "올림 또는 드림"
}
`.trim();

    // =========================
    // ✅ 재시도 로직
    // =========================
    const MAX_TRIES = 3;
    let lastCleaned = "";
    let parsed = null;

    for (let i = 1; i <= MAX_TRIES; i++) {
      const extraWarn = i === 1 ? "" : `
[재시도 경고]
- 이전 출력에 금지된 문자(영문/외국어)가 포함되어 실패했습니다.
- 반드시 한글로만 작성해주세요.
`;
      const data = await callOpenAI(prompt + extraWarn);
      const result = parseJsonFromResponsesAPI(data);
      lastCleaned = result.cleaned;
      parsed = result.parsed;

      // 검증 및 후처리 (cleanTail 적용)
      if (isToneOne) {
        if (!parsed?.body) continue;
        
        // ✨ 후처리: 본문 뒤에 날짜/이름이 붙어있으면 자름
        parsed.body = cleanTail(stripLeading(parsed.body));
        
        if (!hasForeign(parsed.body)) break; 
      } else {
        if (!parsed?.polite || !parsed?.emotional || !parsed?.witty) continue;
        
        // ✨ 후처리: 각 톤별로 정리
        parsed.polite = cleanTail(stripLeading(parsed.polite));
        parsed.emotional = cleanTail(stripLeading(parsed.emotional));
        parsed.witty = cleanTail(stripLeading(parsed.witty));
        parsed.sign = stripLeading(parsed.sign || "");

        const bad = [parsed.polite, parsed.emotional, parsed.witty].some(hasForeign);
        if (!bad) break;
      }
    }

    // =========================
    // ✅ 최종 응답
    // =========================
    if (isToneOne) {
      if (!parsed?.body) return res.status(500).json({ error: "JSON 파싱 실패", detail: lastCleaned });
      if (hasForeign(parsed.body)) return res.status(500).json({ error: "외국어 포함 오류", detail: parsed.body });
      return res.status(200).json(parsed);
    }

    if (!parsed?.polite) return res.status(500).json({ error: "JSON 파싱 실패", detail: lastCleaned });
    if ([parsed.polite, parsed.emotional, parsed.witty].some(hasForeign)) {
      return res.status(500).json({ error: "외국어 포함 오류", detail: parsed });
    }

    return res.status(200).json(parsed);

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "서버 오류", detail: String(e) });
  }
}
