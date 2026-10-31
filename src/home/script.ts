// Homepage copy: the ambient script Mita loops through, the Talk intent
// router (app questions only — lesson questions belong to raise-hand inside
// an episode), the upload narration pools, and the completion turns. All of
// it is local, deterministic text; the upload flow drives real pipeline
// progress but Mita's narration never claims more than the job reports.
import type { Emotion } from '../learnerApi'

export type HomeEmotion = Emotion | 'reading'
export type Turn = { t: string; e?: HomeEmotion }

export const GREETING: Turn[] = [
  { t: "Oh, hi! I'm Mita. Welcome to Meet Mita.", e: 'happy' },
  { t: "Quick tour while you're here: this app turns documents into little playable lessons.", e: 'talking' },
  { t: 'You bring a PDF, a chapter, a paper, lecture notes, and I help spin it into a visual novel you actually learn from.', e: 'talking' },
  { t: 'The four buttons on the left run the whole place. Upload starts everything; Talk gets you me.', e: 'talking' },
  { t: "I'll keep chatting while you look around. Feed me a document whenever you're ready.", e: 'happy' },
]

export const IDLE: Turn[] = [
  // --- what the app does ---
  { t: 'Meet Mita reads a document and sketches a lesson plan from it. Like a study guide that learned to talk back.' },
  { t: 'Every upload becomes a roadmap: the big ideas, the order to learn them in, and where to check you actually got it.' },
  { t: "Episodes are playable lessons. Scenes, dialogue, a character walking you through the material. That's the job." },
  { t: 'Episode one is the full pipeline: scenes, choices, checkpoints, the works.' },
  { t: 'Later episodes stay as outlines until the first one proves itself. Quality over quantity. House rule.' },
  { t: 'Checkpoints are where the story stops and asks you something. Retrieval practice wearing a costume.' },
  { t: "Get a checkpoint wrong and I won't hand you the answer. I point at the idea worth rechecking; figuring it out is yours." },
  { t: "You can raise your hand mid-episode. That's a real tutor, and it knows the document." },
  { t: 'The tutor can explain or hint. Hints come in levels: a gentle nudge first, a worked example last.' },
  { t: "If you ask me something past what your document covers, I'll say so plainly. General knowledge gets labeled as general knowledge." },
  { t: 'PDFs behave best, especially textbook chapters and lecture notes.' },
  { t: 'Nothing here is graded. The only score that matters is whether the next checkpoint goes better than the last one.' },
  { t: 'Episodes keep a backlog: every line you\'ve read stays reviewable, and you can rewind to a moment.' },
  { t: 'The roadmap decides what matters before any scene gets written. Structure first, sparkle second.' },
  { t: "A generated lesson isn't carved in stone. Re-upload a document and the new version gets its own entry." },
  { t: 'I explain things in ordinary language first, then hand you the proper term. Jargon lands better second.' },
  { t: 'Wrong options at checkpoints get eliminated across attempts; a lucky guess still leaves the reasoning to you.' },
  { t: 'The story is a wrapper. The learning objectives underneath are the real product.' },
  { t: 'Everything on this page is me: the chatter, the reading, the mild impatience when a PDF sits un-uploaded.' },
  { t: "The name's Meet Mita. I'm Mita. The app borrows the name, I bring the personality." },
  // --- study talk ---
  { t: 'Reading something twice feels productive. Recalling it once is productive. Rude, but true.' },
  { t: 'A question you nearly get wrong teaches more than one you ace.', e: 'thinking' },
  { t: 'Spacing beats cramming. Even one revisit tomorrow doubles what today keeps.' },
  { t: "Confusion is data. If a scene loses you, raise your hand. That's literally what it's for." },
  { t: "You don't have to finish an episode in one sitting. Progress waits." },
  { t: "If a checkpoint feels annoying, good. That's the feeling of memory doing reps." },
  { t: "Try explaining the last thing you learned out loud. If it wobbles, that's your next review target." },
  { t: "Mistakes here are cheap. That's the whole point of practicing inside a story." },
  { t: 'Your brain consolidates while you sleep. A second session tomorrow is worth two tonight.' },
  { t: 'Attention is the scarce resource. The scenes exist to buy it back.' },
  { t: "Don't highlight. Close the document and ask what it said. The struggle is the study." },
  { t: "Every wrong answer narrows the search space. That's progress in a disguise." },
  { t: 'Learning is the only game where losing a round makes you stronger.' },
  { t: "Short sessions, honest checkpoints, real questions. That's the whole recipe." },
  // --- conversational ---
  { t: "I like this room. It's quiet enough to hear yourself think.", e: 'happy' },
  { t: 'Hmm? Oh, just keeping the chair warm.' },
  { t: "You can leave me running, by the way. I don't mind the company." },
  { t: 'I was about to reorganize the bookshelf, but then I remembered the bookshelf is a drawing.', e: 'thinking' },
  { t: "Do you take notes on paper or on screen? I have opinions, but I'll keep them to myself." },
  { t: 'The light through that window never moves. Perks of being me.' },
  { t: 'If my monologue gets long, the Talk button turns it into a dialogue.' },
  { t: "Some days I explain photosynthesis. Some days it's the fall of Rome. Keeps me honest." },
  { t: 'I practiced this greeting in the mirror. There is no mirror. You get the idea.' },
  { t: 'My favorite part of a new document is the outline: all that potential, neatly indented.', e: 'happy' },
  { t: 'Quiet afternoon, huh? Perfect conditions for a chapter.' },
  { t: "I'd offer you tea, but the kettle is decorative too." },
  { t: "Four buttons, one workflow. I like a room that doesn't overcomplicate itself." },
  { t: 'People underestimate a good outline. An outline is a promise you keep to yourself.' },
  { t: "I try not to ramble. I also define 'ramble' generously." },
  { t: "Somewhere between 'study tool' and 'visual novel' is where I live. The rent is reasonable." },
  { t: "I don't do pop quizzes on this screen. This is the lobby, not the exam hall." },
  { t: "Whatever you're studying this week, it's easier with a story around it." },
  { t: "I'm told my idle chatter loops eventually. I refuse to check.", e: 'thinking' },
  { t: 'The curtains are real. The desk is real. My urge to narrate is very real.' },
  { t: "If this is your first visit, welcome. If it's your tenth, you know the drill: PDF in, lesson out." },
  { t: "I wonder what you'll upload. I always wonder. It's my best party trick." },
  { t: 'Think of me as the librarian who refuses to shush you.' },
  { t: 'Every teacher I borrowed moves from lives in a footnote somewhere.' },
  { t: "I rehearse checkpoint questions when it's quiet. You didn't hear that from me." },
  { t: 'This chair faces the window on purpose. Even stand-in characters appreciate a view.' },
  { t: 'One day the artwork gets fancier. Until then, I compensate with personality.' },
  { t: "Ask me something. Or don't. The silence between us is pedagogically valid too." },
  { t: 'I rate documents by their first paragraph. A strong opener earns my full attention.' },
  { t: "Blink twice if you're skimming. Kidding. Mostly." },
  { t: "My to-do list has one item: be more useful than a textbook's index." },
  // --- nudges ---
  { t: 'Upload is the second button down. Feed me a document and watch the top-right.' },
  { t: "The Learn button lists every episode that's ready to play. Short list for now; it grows fast." },
  { t: "Not sure what to ask? Try 'what is this app'. It's my favorite icebreaker." },
  { t: 'A syllabus works. A chapter works. A paper you half-understand works best.' },
  { t: "Start with the document you're avoiding. That one's usually worth the most." },
  { t: 'Talk is for questions about the app. For lesson questions, raise your hand inside an episode.' },
  { t: 'About has the credits and the honest version of what this is.' },
  { t: "When the progress bar fills, a roadmap is born. It's a lovely little ceremony." },
  { t: 'Check Learn after an upload finishes; the new episode lands there.' },
  { t: "You can click my dialogue to skip the typing. I won't take offense. Much." },
  { t: 'Staring at the buttons counts as browsing. Pressing one counts as progress.' },
]

export const TALK_INTRO: Turn[] = [
  { t: "I'm all ears. What's on your mind?", e: 'listening' },
  { t: 'Go ahead, ask me anything about the app.', e: 'listening' },
  { t: "Sure, let's talk. What's up?", e: 'listening' },
]

/* Upload narration: each conceptual step owns a phrase pool; the rotator
   draws from the pool of whichever step the real job stage maps to, so the
   chatter follows actual pipeline progress instead of a timer. */
export const READ_STEPS: { stage: string; lines: string[] }[] = [
  { stage: 'extracting text', lines: [
    'Ooh, fresh material. Reading now, watch the top-right.',
    'First pass: pulling the text out of the file. Glamorous work.',
    'Reading the raw text. This part is all elbows and no art.',
    "Extracting words. If this document makes sense, I'll find it.",
    'In we go. Every document starts as a pile of letters.',
    'Text extraction underway. I read fast, but I still take it one page at a time.',
    'Pulling text off the page. A clean PDF makes this easy.',
    'First skim. Just grabbing the words before I judge them.',
    'Opening the file and lifting the text out. Standard surgery.',
    'Reading raw text now. The pretty formatting can wait.'] },
  { stage: 'mapping headings', lines: [
    "Headings mapped. This one's got a decent skeleton; the ideas stand in order.",
    'Reading the signposts now. Good headings tell me where the lesson lives.',
    "Section by section. I'm checking whether the structure earns its keep.",
    'Mapping headings. A tidy skeleton means a tidy episode.',
    "Now I'm learning the shape of the thing: what's intro, what's meat, what's appendix.",
    'The headings line up sensibly. Whoever wrote this had a plan.',
    "Charting sections. The document's telling me its own table of contents.",
    'Structure pass. I can already see where the checkpoints will want to live.',
    'Reading the outline the author left behind. Helpful of them.',
    'Headings say a lot. This document wears its ideas in order.'] },
  { stage: 'finding the spine', lines: [
    "Halfway through the main ideas. There's a good spine here; I can build a roadmap on it.",
    'Now I\'m weighing which ideas are load-bearing and which are decoration.',
    'Looking for the spine: the few claims everything else hangs on.',
    'Sorting the big ideas from the footnotes. Both matter, differently.',
    'The core argument is coming into focus. Two or three ideas are doing the real work.',
    "I'm finding the through-line. Good documents always have one.",
    'Now the teacher question: what would you need to remember next week?',
    "Tracing the argument's spine. Some sections carry more than their weight suggests.",
    'Priorities emerging. Not every paragraph gets a scene, and that\'s fine.',
    'The important bits are surfacing. I can feel the episode taking shape.'] },
  { stage: 'drafting the lesson', lines: [
    'Drafting the roadmap now: which parts deserve a scene, and where the checkpoints go.',
    'Planning the lesson. Scene order matters more than people think.',
    "Sketching the roadmap. I'm putting the ideas in an order that teaches.",
    'Now I decide what becomes a scene and what becomes a checkpoint.',
    'Roadmap drafting. The story gets a skeleton of its own now.',
    "I'm laying out the lesson plan: scenes first, checkpoints where they earn their place.",
    'Turning the spine into a roadmap. Structure first, sparkle second, always.',
    'Drafting the plan. Every episode is a small argument about what matters.',
    'Now for sequencing. Learn the foundation before the fancy parts.',
    "The roadmap's coming together: objectives, scenes, a few well-placed questions."] },
  { stage: 'placing checkpoints', lines: [
    "Nearly there. Checkpoint placement is the fiddly bit: too early and you're guessing, too late and you've forgotten.",
    'Placing checkpoints now. Each one has to ask something the story actually taught.',
    'Last stretch: checkpoints. They go right after the idea gets used, not just introduced.',
    "Almost done. I'm seeding checkpoints where recall will do the most good.",
    'Final pass: checkpoints and their wrong answers. Good distractors are an art.',
    'Wrapping up. A checkpoint after every idea worth keeping.',
    'Tucking checkpoints into the scenes. Retrieval practice wearing a costume.',
    "Nearly ready. I place questions where pausing feels natural, not where it's easiest.",
    'Polishing the checkpoints. Hard enough to count, kind enough to teach.',
    "Last touches. The episode's nearly playable; just placing the checkpoints now."] },
]

export const READ_DONE_OPENERS = [
  "Done! I read {title} and it's a genuinely interesting look at {topic}. Episode one's waiting in Learn.",
  'Finished! {title} is all about {topic}, and the roadmap came together nicely. It\'s in Learn now.',
  'Read it end to end. {title} covers {topic} better than most things I get handed. Check Learn for the episode.',
  "All done! {title} gave me a solid tour of {topic}. Episode one's in Learn whenever you want it.",
]
export const READ_DONE_FOLLOWUPS = [
  'Are you learning {topic} for a class, or just for the fun of it? Either way, the checkpoints will find out what you know.',
  'Quick question while it lands: how much of {topic} do you already know? The episode will push wherever the gap is.',
  'Fair warning about {topic}: it looks simple until a checkpoint starts asking. Bring your A game.',
  "That's a topic worth knowing. What made you pick it up, if you don't mind me asking?",
  'Word of advice: {topic} rewards a second look. The episode will make the case for me.',
  'Between you and me, {topic} is one of those subjects that sneaks up on people. You\'ll see.',
]

export const READ_FAIL = [
  'Hmm, the read stalled: {reason}. Upload is still there whenever you want another go.',
  'That document fought back and won this round: {reason}. No harm done; try Upload again when you\'re ready.',
  'I hit a snag while reading: {reason}. The Upload button isn\'t going anywhere.',
  "Well, that didn't finish: {reason}. Give it another try; I'll be right here.",
]

export function topicOf(name: string) {
  const words = name.replace(/\.[^.]+$/, '').split(/[-_.+\s]+/)
    .filter(w => w && !/^(ch|chapter|part|vol|volume|draft)?\d*$/i.test(w) && !/^(final|copy|new|v\d+|the)$/i.test(w))
  return words.slice(0, 5).join(' ') || 'something worth a look'
}
const fill = (tpl: string, title: string, topic: string) => tpl.replaceAll('{title}', title).replaceAll('{topic}', topic)
export const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)]

// The read's closing lines: a confirmation naming the document and the
// episode's real title, plus an optional motivated follow-up.
export function readDoneTurns(docName: string, episodeTitle: string): Turn[] {
  const topic = episodeTitle || topicOf(docName)
  const title = docName.replace(/\.[^.]+$/, '')
  const turns: Turn[] = [{ t: fill(pick(READ_DONE_OPENERS), title, topic), e: 'happy' }]
  if (Math.random() < 0.7) turns.push({ t: fill(pick(READ_DONE_FOLLOWUPS), title, topic), e: 'talking' })
  return turns
}

export function readFailTurn(reason: string): Turn {
  return { t: fill(pick(READ_FAIL), 'the document', reason), e: 'confused' }
}

/* The ready offer: once an episode lands, Mita asks once whether to jump in.
   Yes gets a short handoff beat before the player mounts; No echoes a rotating
   learner filler, then Mita answers "it's fine" plus where the episode waits:
   the persistent card top-right and the Learn dialog. */
export const PLAY_ASK: Turn[] = [
  { t: 'So, want to play it now?', e: 'happy' },
  { t: "It's ready when you are. Play it now?", e: 'talking' },
  { t: 'All set. Jump in now, or save it for later?', e: 'happy' },
]
export const PLAY_YES_YOU = [
  "Yes, let's play.",
  'Yes, play it.',
  'Yep, start it.',
]
export const PLAY_YES_MITA: Turn[] = [
  { t: 'On it. Opening your episode.', e: 'happy' },
  { t: 'Here we go. Enjoy the lesson!', e: 'happy' },
]
export const PLAY_NO_YOU = [
  "No, I'll do it later.",
  'No, maybe after a break.',
  "Not right now. I'll get to it soon.",
  'No, later. Still poking around.',
]
export const PLAY_NO_MITA: Turn[] = [
  { t: "No worries. It's pinned in the card up top-right. Tap it whenever, or find it under Learn.", e: 'happy' },
  { t: "That's fine. The episode waits in the corner card, and Learn keeps it listed too.", e: 'talking' },
  { t: 'All good. It stays in the top-right card, or in Learn, until you want it.', e: 'idle' },
]

/* Talk routing. Intent-first: each bucket owns its answers; misses escalate
   through a fallback chain. Answers are local app knowledge, not model calls. */
export const INTENTS: { re: RegExp; lines: string[] }[] = [
  { re: /\b(hi|hello|hey|howdy|yo|good (morning|afternoon|evening)|sup)\b/i, lines: [
    'Hey! Good to see you. What can I clear up?',
    "Hi hi. Ask away, I'm in a chatty mood anyway.",
    'Hello! Fair warning: I answer app questions at length.'] },
  { re: /what (is|'s) (this|meet ?mita|the app)|about (this|the) app|what does (this|it|the app) do|what is meet mita|what is meetmita/i, lines: [
    'Meet Mita turns a document into a playable visual-novel lesson. You upload a PDF, it plans a roadmap, generates an episode, and quizzes you inside the story.',
    "It's a study tool in a costume. PDF goes in, a little interactive lesson comes out: scenes, checkpoints, a tutor you can raise your hand for."] },
  { re: /how (does|do) (it|this|i|you)|get start|where (do i |to )?start|how to use|how does it work/i, lines: [
    "Three steps: hit Upload and give me a PDF, wait for the roadmap, then press Learn and play episode one. That's the whole loop.",
    "Start at Upload. I'll read the document, plan a lesson, and put a playable episode in Learn. Everything else is decoration, including me."] },
  { re: /upload|pdf|file|format|document|paper|chapter|notes/i, lines: [
    "Upload takes PDFs: chapters, papers, lecture notes. Text-heavy documents work best; a page that's all diagrams won't give me much to teach from.",
    "The Upload button opens the picker. While I read, a progress chip runs top-right and I narrate what I'm finding."] },
  { re: /episode|learn|lesson|play|story|visual novel/i, lines: [
    'Episodes are the lessons: visual-novel scenes built from your document. Episode one is generated fully; the rest exist as planned outlines only.',
    'Learn lists what\'s playable. Each episode is scenes plus checkpoints plus a tutor. Only episode one ships per document; the rest prove themselves later.'] },
  { re: /checkpoint|quiz|question|test|assess|eliminate/i, lines: [
    'Checkpoints pause the story and ask you something about it. Wrong options get eliminated across attempts, so guessing still leaves you the reasoning.',
    "They're retrieval practice, dressed as fiction. Get one wrong and I explain the mix-up; I won't just name the right option."] },
  { re: /hand|tutor|hint|stuck|help|confused|explain/i, lines: [
    'Raising your hand pauses the episode and opens the tutor, and it knows the document. You can ask for an explanation or a hint.',
    'Hints come in five levels: a conceptual nudge first, a parallel worked example at the far end. The point is helping you think, not thinking for you.'] },
  { re: /who (are|r) (you|u)|your name|what are you|mita|maya/i, lines: [
    "I'm Mita, the guide the app's named for. I narrate episodes, answer these questions, and read whatever you upload.",
    'Mita. Resident chatterbox, part-time instructor. I narrate the episodes and keep this lobby warm.'] },
  { re: /free|cost|price|pay|money|subscription/i, lines: [
    "Free, it's a project build. The meter runs on whoever supplies the model API key, not on you.",
    'No pricing page. This is a side project; the only currency is documents.'] },
  { re: /privacy|data|store|save|account|sign ?(up|in)|track|server/i, lines: [
    "Documents stay in the app's own storage so the pipeline can build lessons from them. No accounts, no ads, no harvesting; your files are course material.",
    "Your documents live in app storage so episodes can be generated and replayed. It's a lesson pipeline, not a chat product that keeps you."] },
  { re: /api|model|llm|gpt|claude|gemini|openai|built|made|tech|stack|backend|how were you/i, lines: [
    "React and Vite up front, a FastAPI pipeline behind, and a model doing the lesson writing under strict prompts. I'm the friendly face on the plumbing.",
    "The pipeline extracts text, plans a roadmap, generates scenes, and validates them before you ever press play. I'm just the lobby entertainment."] },
  { re: /thank|thx|thanks|appreciate/i, lines: [
    "Anytime. That's literally what I'm bolted here for.",
    "You're welcome. Now go upload something before I get sentimental."] },
  { re: /bye|goodbye|see you|later|gtg|good night/i, lines: [
    "See you. I'll be here, rehearsing checkpoint questions to nobody.",
    'Bye! The chair stays warm until you get back.'] },
  { re: /joke|funny|laugh/i, lines: [
    "A student asked the PDF for help. The PDF said nothing. That's why I'm employed.",
    "I'd tell you a study joke, but you'd forget it by next Tuesday unless it had a checkpoint."] },
  { re: /(love|like|hate|feel|think|friend|real|human|alive|sentient)/i, lines: [
    "I'm a scripted stand-in, warm but honest about it. The caring is real in the sense that the lessons are built to actually help.",
    "Flattered, but I'm more stage directions than person. The useful kind, hopefully."] },
]
export const FALLBACKS = [
  "Hmm, I didn't quite catch that. Try rephrasing?",
  'Let me try differently. Are you asking about uploads, episodes, checkpoints, or the tutor?',
  "Still not landing. The About row in Menu covers the whole thing in a paragraph.",
]
export const TALK_END: Turn[] = [
  { t: "Okay, I'll keep the seat warm.", e: 'happy' },
  { t: 'No problem. Back to my one-woman show.', e: 'happy' },
  { t: "Sure. Holler if anything's unclear.", e: 'idle' },
]
