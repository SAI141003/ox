// Small talk with no model: "hey how are you", "thanks", "good night". A model
// call for a greeting carried the whole system prompt (3,500 tokens in the
// terminal, about 330 in the app) to write one friendly line. These are
// answered here, for 0 tokens and in no time; anything with a request in it
// ("hey, can you fix the build") is not small talk and goes to a model.
// OX_QUICK_REPLY=0 sends small talk to the model as before.

const GREETING = /^(?:(?:hey|hi|hello|hiya|yo|sup|hey there|hi there|hello there|good (?:morning|afternoon|evening|day)|morning|evening)(?:\s+(?:ox|there|buddy|friend|mate|man|bro|team))?)$/;
const HOW_ARE_YOU = /^(?:how(?:'s| is)? (?:it going|everything|life|things|your day)|how are (?:you|u|ya)(?: doing| today)?|how r u|how have you been|how(?:'re| are) things|what(?:'s| is) up|whats up|wassup|how do you do|you good|are you (?:ok|okay|there|awake))$/;
const THANKS = /^(?:thanks?(?: you| u)?(?: so much| a lot| very much)?|thank you(?: so much| very much)?|thx|ty|cheers|appreciate it|much appreciated|great,? thanks|perfect,? thanks|awesome,? thanks|nice,? thanks)$/;
const ACK = /^(?:ok(?:ay)?|k|kk|cool|nice|great|awesome|perfect|got it|sounds good|alright|all right|sure|noted|understood|good|lovely|amazing|wow)$/;
const BYE = /^(?:bye|goodbye|good bye|see (?:you|ya|u)(?: later| soon| tomorrow)?|good night|goodnight|night|later|ttyl|catch you later|take care)$/;

const clean = (t) => String(t ?? '').toLowerCase().replace(/[!.?,~…]+/g, ' ').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Which kind of small talk this whole message is, or null. */
export function smallTalkKind(text) {
  const t = clean(text);
  if (!t || t.split(' ').length > 9) return null;
  // "hey, how are you" / "hi ox how's it going": a greeting and a how-are-you.
  const parts = t.replace(/^(hey|hi|hello|yo|hiya|good (?:morning|afternoon|evening))\s+(?:(?:ox|there|buddy|friend|mate)\s+)?/, '$1|').split('|');
  if (parts.length === 2 && GREETING.test(parts[0]) && HOW_ARE_YOU.test(parts[1])) return 'how';
  if (HOW_ARE_YOU.test(t)) return 'how';
  if (GREETING.test(t)) return 'hello';
  if (THANKS.test(t)) return 'thanks';
  if (BYE.test(t)) return 'bye';
  if (ACK.test(t)) return 'ack';
  return null;
}

const REPLIES = {
  hello: ['Hey! What can I do for you?', 'Hi! What are we working on?', 'Hello! What do you need?'],
  how: ["I'm good, thanks for asking! What can I help you with?", 'Doing well! What are we working on today?', "All good here. What's on your mind?"],
  thanks: ["You're welcome!", 'Anytime!', 'Glad to help!'],
  ack: ['Great. Tell me what you want next.', 'Okay. What next?', 'Got it.'],
  bye: ['Bye! I\'m here when you need me.', 'Take care!', 'See you soon!'],
};

/**
 * The reply to a small-talk message, or null when it is not one (or quick
 * replies are off). `seed` picks among the phrasings (the clock by default),
 * so it does not answer the same way every time.
 */
export function quickReply(text, { env = process.env, now = new Date(), seed = Date.now() } = {}) {
  if (env.OX_QUICK_REPLY === '0') return null;
  const kind = smallTalkKind(text);
  if (!kind) return null;
  const list = REPLIES[kind];
  let reply = list[Math.abs(Math.floor(seed / 1000)) % list.length];
  if (kind === 'hello') {
    const h = now.getHours();
    const part = h < 5 ? null : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    if (/good (morning|afternoon|evening)/.test(clean(text)) && part) reply = `${part}! What can I do for you?`;
  }
  return reply;
}
