export default async function handler(req, res) {
  // CORS 설정
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

    // 1. 톤 정의
    const toneDef = (t) => {
      if (t === "polite") return "격식 있고 헌정문에 가까운 어투";
      if (t === "emotional") return "따뜻하지만 가볍지 않은 어투";
      return "산뜻하고 센스 있는 어투 (가볍지만 예의 유지)";
    };

    // 2. 기본 문자열 정리
    const stripLeading = (s) => (s ?? "").replace(/^[\s\uFEFF\xA0]+/, "");

    // ✅ [핵심 수정 1] 앞부분(수신자/호칭) 강제 제거 함수
    const cleanHead = (text) => {
      if (!text) return "";
      let cleaned = text.trim();

      // (1) "To.", "받는 사람:", "수신:" 같은 헤더 제거
      cleaned = cleaned.replace(/^(To|Dear|To\.|받는\s?사람|받는\s?분|수신)[:.]?\s*/i, "");

      // (2) 입력받은 'to'(받는 사람 이름)가 문장 처음에 있다면 제거
      if (to) {
        // 특수문자 이스케이프
        const safeTo = to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 패턴: (시작) + (공백?) + 이름 + (호칭/조사?) + (쉼표/마침표/줄바꿈?)
        // 예: "홍길동 부장님," 또는 "홍길동 귀하" 로 시작하면 제거
        const toRegex = new RegExp(`^\\s*${safeTo}\\s*(님|부장|과장|팀장|대표|사장|이사|선생|여사|귀하|에게|께)?\\s*[,.]?\\s*`, 'i');
        cleaned = cleaned.replace(toRegex, "");
      }

      // (3) "귀하" 단독으로 시작하는 경우 제거 (예: "귀하의 노고에...")
      // 단, "귀하의" 처럼 문장 구성요소면 놔두고, "귀하," 처럼 호칭이면 제거
      cleaned = cleaned.replace(/^귀하\s*[,.]\s*/, "");

      return cleaned.trim();
    };

    // ✅ [핵심 수정 2] 뒷부분(발신자/날짜) 강제 제거 함수
    const cleanTail = (text) => {
      if (!text) return "";
      let cleaned = text;

      // (1) 보내는 사람 이름 제거
      if (from) {
        const safeFrom = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const fromRegex = new RegExp(`\\s*${safeFrom}\\s*(드림|올림|배상)?\\.?$`);
        cleaned = cleaned.replace(fromRegex, "");
      }

      // (2) 날짜 패턴 제거
      const dateRegex = /\s*\d{4}[.\-년]\s*\d{1,2}[.\-월]\s*\d{1,2}[일]?\.?$/;
      cleaned = cleaned.replace(dateRegex, "");
      
      return cleaned.trim();
    };

    // 통합 클리너 (앞뒤 다 자름)
    const cleanText = (text) => cleanTail(cleanHead(stripLeading(text)));


    // 3. 영문/외국어 감지
    function hasForeign(s) {
      if (!s) return false;
      if (/[A-Za-z]/.test(s)) return true;
      const allowed = /^[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F0-9\s.,!?'"()\-[\]{}~·…:;/%&+=<>@#^_|\\\n\r]+$/;
      return !allowed.test(s);
    }

    // 4. OpenAI 호출
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

    // 5. JSON 파싱
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
    // ✅ 프롬프트 수정 (시작 금지 규칙 강화)
    // =========================
    const commonRules = `
[상황 해석 규칙]
- 상황이 "생신/환갑/칠순"인 경우: 인생의 무게, 존경, 평안, 가족의 감사 강조 (단순 생일 축하 지양)
- 상황이 "퇴직/정년"인 경우: 헌신, 명예로운 마무리, 새로운 시작 응원
- 상황이 "공로/감사"인 경우: 구체적인 기여, 태도, 신뢰 강조
- 상황이 "기념/창립"인 경우: 역사, 성장, 함께한 시간 강조

[작성 금지 규칙 - 위반 시 실패]
1. **절대 'To', '받는 사람', '${to}'(이름/호칭), '귀하'로 문장을 시작하지 마라.**
   - 편지 형식이 아니라 '상패 본문'만 필요하다.
   - 예시(X): "홍길동 부장님, 지난 30년간..."
   - 예시(O): "지난 30년간 보여주신 헌신에 깊이 감사드립니다..."
2. **절대 본문 끝에 '날짜'나 '보내는 사람(${from})'을 적지 마라.**
   - 디자인 시 하단에 별도로 들어간다. 중복 표기 금지.
3. 한국어 220~240자 내외.
4. 존댓말 사용.
`;

    const prompt = isToneOne ? `
너는 상패 문구 전문 카피라이터다. 한국어로만 작성하라.

${commonRules}

[추가 요청]
- 기존 문구의 '추가 버전'이다. 아래 내용과 겹치지 않게 작성:
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
너는 상패 문구 전문 카피라이터다. 한국어로만 작성하라.

${commonRules}

[톤 정의]
- polite: 격식, 헌정문 스타일
- emotional: 감성적, 따뜻함
- witty: 센스, 위트, 산뜻함 (가벼움 주의)

[서명 처리]
- "올림" 또는 "드림" 중 하나를 'sign' 필드에만 넣고, 본문에는 넣지 마라.

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
    // ✅ 실행 및 재시도 루프
    // =========================
    const MAX_TRIES = 3;
    let lastCleaned = "";
    let parsed = null;

    for (let i = 1; i <= MAX_TRIES; i++) {
      const extraWarn = i === 1 ? "" : `
[경고]
- 이전 출력에 금지된 문자(영어)나 형식이 포함되었습니다.
- '받는 사람 이름'으로 시작하지 말고, 바로 내용부터 시작하세요.
- 한글만 사용하세요.
`;
      const data = await callOpenAI(prompt + extraWarn);
      const result = parseJsonFromResponsesAPI(data);
      lastCleaned = result.cleaned;
      parsed = result.parsed;

      // 검증 및 후처리 (CleanHead + CleanTail 적용)
      if (isToneOne) {
        if (!parsed?.body) continue;
        
        // ✨ 앞뒤 자르기 적용
        parsed.body = cleanText(parsed.body);
        
        if (!hasForeign(parsed.body)) break; 
      } else {
        if (!parsed?.polite || !parsed?.emotional || !parsed?.witty) continue;
        
        // ✨ 앞뒤 자르기 적용
        parsed.polite = cleanText(parsed.polite);
        parsed.emotional = cleanText(parsed.emotional);
        parsed.witty = cleanText(parsed.witty);
        parsed.sign = stripLeading(parsed.sign || "");

        const bad = [parsed.polite, parsed.emotional, parsed.witty].some(hasForeign);
        if (!bad) break;
      }
    }

    // =========================
    // ✅ 최종 응답
    // =========================
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
