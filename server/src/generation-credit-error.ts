export function isGenerationCreditError(error: string | null | undefined): boolean {
  if (!error) return false;
  const message = error.toLowerCase().replaceAll(/[_-]+/g, " ");
  return /\b(?:out of|insufficient|not enough|no(?: remaining| more| available)?) credits?\b/.test(message)
    || /\bcredits? (?:balance )?(?:is |are )?(?:insufficient|exhausted|depleted|too low)\b/.test(message)
    || /\b(?:insufficient|not enough|low|exhausted) (?:account |credit )?balance\b/.test(message)
    || /\b(?:account |credit )?balance (?:is )?(?:insufficient|too low|exhausted)\b/.test(message)
    || /\binsufficient quota\b/.test(message)
    || /\b(?:exceeds? (?:your|the) (?:remaining |available )?credits?|credits? (?:left|remaining).{0,100}(?:required|requested|needed))\b/.test(message);
}
