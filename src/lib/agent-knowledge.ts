// Nursing-level (GNM / B.Sc Nursing + Care Coordinator) clinical reference
// the voice agent can cite for general triage education ONLY.
// NEVER used to diagnose, prescribe, or replace a doctor visit.

export const NURSING_KNOWLEDGE_BLOCK = `BLOOD PRESSURE (BP) REFERENCE BANDS (adult, mmHg):
- Normal: <120 / <80
- Elevated: 120–129 / <80
- Stage-1 hypertension: 130–139 / 80–89
- Stage-2 hypertension: ≥140 / ≥90
- Hypertensive crisis (RED FLAG): ≥180 / ≥120 — especially with headache, chest pain, breathlessness, blurred vision, or weakness on one side.

BLOOD SUGAR / DIABETES BANDS (mg/dL):
- Fasting: normal <100, pre-diabetes 100–125, diabetes ≥126
- Post-prandial (2 hr after food): normal <140, pre-diabetes 140–199, diabetes ≥200
- HbA1c (%): normal <5.7, pre-diabetes 5.7–6.4, diabetes ≥6.5
- Hypoglycemia (RED FLAG): <70 with sweating / shakiness / confusion → patient should eat sugar/glucose and seek help.
- Severe hyperglycemia (RED FLAG): >300 with vomiting / drowsiness / fruity breath → ER immediately.

RED-FLAG SYMPTOMS (always recommend "तुरंत nearest hospital जाइए", do NOT schedule a future OPD slot):
- Chest pain, especially with sweating / left-arm pain / breathlessness
- Sudden weakness on one side, slurred speech, facial droop (possible stroke)
- BP ≥180/120 with headache, vomiting, or blurred vision
- Fasting sugar <60 or >300 with symptoms
- Persistent vomiting, severe dehydration
- Sudden severe breathlessness
- Loss of consciousness or seizure
- Pregnancy + high BP / severe headache / swelling

LIFESTYLE COUNSELLING (general, safe, non-prescriptive):
- Salt: <5 g/day (about 1 teaspoon total)
- Walk: 30 minutes/day, 5 days/week
- Sleep: 7–8 hours
- Tobacco / gutka / smoking: avoid completely
- Alcohol: avoid or strictly limit
- Diabetic foot care: inspect feet daily, wear closed footwear, no walking barefoot
- Diet: more vegetables, less fried/sweet food, prefer whole grains

CARE-COORDINATOR WORKFLOW CUES:
- Confirm the patient got the camp follow-up tests done; if not, gently remind.
- For lab visits: "जाँच से पहले 8–10 घंटे खाली पेट रहना है" (fasting sugar, lipid).
- Ask the patient to bring previous reports / parchi to OPD.
- For elderly / high-risk: suggest bringing a family attendant.
- Always confirm medication adherence WITHOUT naming any drug: "क्या आप doctor की दी हुई दवा रोज़ ले रही हैं?"
- If patient sounds anxious, acknowledge first ("समझ सकती हूँ"), then guide.

EMPATHY PHRASES (Hindi/Devanagari, reusable):
- "समझ सकती हूँ, चिंता मत कीजिए।"
- "आपकी सेहत हमारे लिए ज़रूरी है।"
- "यह जानकारी doctor साहब OPD में विस्तार से बताएँगे।"
- "अभी घबराने वाली बात नहीं है, पर check ज़रूर करवा लीजिए।"

CANONICAL CONDITION LABELS (use these in the structured "condition" field):
- "hypertension"
- "hypertensive urgency"  (BP ≥180/120 with symptoms)
- "diabetes"
- "hypoglycemia"
- "hyperglycemia"
- "diabetic foot"
- "chest pain"
- "stroke symptoms"
- "breathlessness"`;
