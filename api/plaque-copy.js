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

    // ✅ 기본 문자열 정리
    const stripLeading = (s) => (s ?? "").replace(/^[\s\uFEFF\xA0]+/, "");

    // ✅ [수정됨] 앞부분 클리너 (너무 과도하게 자르지 않도록 완화)
    const cleanHead = (text) => {
      if (!text) return "";
      let cleaned = text.trim();

      // 1. 명백한 "To." "받는사람:" 같은 라벨만 제거
      // 문장 속의 이름은 건드리지 않음 (문맥 파괴 방지)
      cleaned = cleaned.replace(/^(To|Dear|To\.|받는\s?사람|받는\s?분|수신)[:.]?\s*/i, "");

      // 2. "귀하"가 단독으로 덩그러니 있는 경우만 제거
      if (cleaned.startsWith("귀하")) {
         // "귀하의 노고에" -> 유지 / "귀하, 지난 시간..." -> 제거
         if (/^귀하\s*[,.]\s*/.test(cleaned)) {
            cleaned = cleaned.replace(/^귀하\s*[,.]\s*/, "");
         }
      }

      return cleaned.trim();
    };

    // ✅ 뒷부분 클리너 (날짜/서명은 여전히 제거)
    const cleanTail = (text) => {
      if (!text) return "";
      let cleaned = text;

      // 1. 보내는 사람 이름 제거
      if (from) {
        const safeFrom = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 이름 뒤에 '드림/올림' 등이 있거나 문장이 끝나는 경우
        const fromRegex = new RegExp(`\\s*${safeFrom}\\s*(드림|올림|배상)?\\.?$`);
        cleaned = cleaned.replace(fromRegex, "");
      }

      // 2. 날짜 패턴 제거
      const dateRegex = /\s*\d{4}[.\-년]\s*\d{1,2}[.\-월]\s*\d{1,2}[일]?\.?$/;
      cleaned = cleaned.replace(dateRegex, "");
      
      return cleaned.trim();
    };

    const cleanText = (text) => cleanTail(cleanHead(stripLeading(text)));

    // ✅ 외국어 감지
    function hasForeign(s) {
      if (!s) return false;
      if (/[A-Za-z]/.test(s)) return true;
      const allowed = /^[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F0-9\s.,!?'"()\-[\]{}~·…:;/%&+=<>@#^_|\\\n\r]+$/;
      return !allowed.test(s);
    }

    // ✅ OpenAI 호출
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
    // ✅ 프롬프트 수정 (자연스러운 시작 유도)
    // =========================
    const commonRules = `
[상황 해석 및 작성 가이드]
- 상황이 "생신/환갑/칠순"인 경우: 인생의 무게와 존경심을 담아 따뜻하게
- 상황이 "퇴직/정년"인 경우: 그동안의 노고를 치하하고 명예로운 마무리를 강조
- 상황이 "공로/감사"인 경우: 구체적인 헌신과 태도에 대한 감사

[작성 규칙 - 매우 중요]
1. **문장 시작 방법**:
   - 받는 사람의 이름을 부르며 시작하지 마십시오. (촌스러움 방지)
   - 대신 **"계절/시간의 흐름", "감사의 마음", "업적에 대한 수식어"**로 자연스럽게 문장을 여십시오.
   - 예시(O): "지난 30년이라는 긴 시간 동안..."
   - 예시(O): "언제나 든든한 버팀목이 되어주신..."
   - 예시(X): "홍길동 부장님, 지난 30년간..." (이름 부르기 금지)

2. **문장 끝맺음**:
   - 본문 내용만 작성하십시오.
   - **날짜와 보내는 사람(서명)은 절대 적지 마십시오.** (디자인 템플릿에 자동 삽입됩니다)

3. **형식**:
   - 한국어 220~240자 내외의 줄글 형태.
   - 존댓말(하십시오체, 해요체 등 톤에 맞게) 사용.
`;

    const prompt = isToneOne ? `
너는 상패 문구 전문 카피라이터다.

${commonRules}

[추가 요청]
- 기존 문구의 '추가 버전'이다. 아래 내용과 겹치지 않게 완전히 새롭게 작성하라:
${avoid_text || "(없음)"}

[톤]
- ${toneDef(tone)}

[입력 정보]
상황: ${occasion}
받는 분(참고용): ${to}
핵심 메시지: ${message}

[출력 JSON]
{ "body": "본문" }
`.trim()
: `
너는 상패 문구 전문 카피라이터다.

${commonRules}

[톤 정의]
- polite: 격식, 헌정문 스타일
- emotional: 감성적, 따뜻함
- witty: 센스, 위트, 산뜻함

[서명 필드 처리]
- "올림" 또는 "드림" 중 하나를 'sign' 필드에만 담고, 본문에는 절대 넣지 마라.

[입력 정보]
상황: ${occasion}
받는 분(참고용): ${to}
핵심 메시지: ${message}

[출력 JSON]
{
  "polite": "본문",
  "emotional": "본문",
  "witty": "본문",
  "sign": "드림"
}
`.trim();

    // =========================
    // ✅ 실행 및 재시도
    // =========================
    const MAX_TRIES = 3;
    let lastCleaned = "";
    let parsed = null;

    for (let i = 1; i <= MAX_TRIES; i++) {
      const extraWarn = i === 1 ? "" : `
[재시도]
- 이전 출력에 영어가 포함되었거나 형식이 올바르지 않았습니다.
- 반드시 한글로만 작성하고, 이름을 부르며 시작하지 마세요.
`;
      const data = await callOpenAI(prompt + extraWarn);
      const result = parseJsonFromResponsesAPI(data);
      lastCleaned = result.cleaned;
      parsed = result.parsed;

      // 후처리
      if (isToneOne) {
        if (!parsed?.body) continue;
        parsed.body = cleanText(parsed.body);
        if (!hasForeign(parsed.body)) break; 
      } else {
        if (!parsed?.polite || !parsed?.emotional || !parsed?.witty) continue;
        
        parsed.polite = cleanText(parsed.polite);
        parsed.emotional = cleanText(parsed.emotional);
        parsed.witty = cleanText(parsed.witty);
        parsed.sign = stripLeading(parsed.sign || "");

        const bad = [parsed.polite, parsed.emotional, parsed.witty].some(hasForeign);
        if (!bad) break;
      }
    }

    // 최종 응답
    if (isToneOne) {
      if (!parsed?.body) return res.status(500).json({ error: "생성 실패", detail: lastCleaned });
      return res.status(200).json(parsed);
    }
    if (!parsed?.polite) return res.status(500).json({ error: "생성 실패", detail: lastCleaned });
    
    return res.status(200).json(parsed);

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "서버 오류", detail: String(e) });
  }
}
