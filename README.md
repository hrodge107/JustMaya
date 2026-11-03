# Meet Mita

![Mita in a study room](public/readme/mita-header.png)

Meet Mita turns the notes students already have into a visual-novel lesson they can play, question, and revisit.

Upload a PDF or photos of notes, and Mita guides you through an episode shaped around that material. Muse Spark develops the lesson and responds to questions in the scene, while Muse Image creates visual aids that appear alongside the dialogue.

Course materials often arrive as static pages. Meet Mita gives students another way to approach them: a focused episode with an anime companion, visual explanations, and moments to recall what they have learned.

The demo creates a playable first episode and a roadmap for the remaining material. That roadmap gives Meet Mita a foundation for expanding a document into a longer series of lessons.

## See the experience

These desktop captures show the development interface and a saved lesson about digital logic.

**Lobby**

![Mita welcomes the learner in the lobby](public/readme/lobby.png)

**Episode with a visual aid**

![Mita explains analog circuits beside a generated picture card](public/readme/episode.png)

**Raise Hand input**

![A question entered in the Raise Hand interface](public/readme/raise-hand.png)

## How Meta models bring the lesson to life

Muse Spark analyzes the source, plans the lesson, writes Mita's dialogue, and reviews the episode before playback. It also supports questions asked during the lesson. Muse Image creates picture cards for selected moments, putting a visual beside the concept Mita is explaining.

The pipeline combines structured model responses with source retrieval, validation, and token budgets. The default models are `muse-spark-1.3-contributor` and `muse-image-1.0`, configured through the Meta Model API. The episode is generated before playback, so each line does not require a new model call. This implementation was built during the hackathon; the repository's history begins on October 27, 2026.

## Designed for the way students already use media

Meet Mita draws on familiar character-driven media to make a study session inviting. In 2024, 98.8% of Philippine internet users aged 10 and older used a cellphone to access the internet, according to the [Philippine Statistics Authority](https://psa.gov.ph/content/percentage-households-internet-connection-increased-488-percent-2024-two-every-three). [Dentsu](https://insight.dentsu.com/sportsandentertainment/culture-commerce) reports that half of Gen Z globally watches anime at least weekly. These figures inform the audience and format; the project's effect on engagement remains a question to test.

## Run locally

You need Node.js and npm, Python, and a Meta Model API key. From the repository root, in PowerShell:

```powershell
Copy-Item .env.example .env
# Add your META_API_KEY to .env.
python -m venv backend/.venv
backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.txt
npm install
npm run dev
```

Open the local URL printed by Vite. The development server starts the FastAPI backend when the virtual environment is present. Keep the API key in the root `.env`, never in a `VITE_` variable or a commit. Uploaded material is processed by the backend and relevant content is sent to Meta's API. The app is a local, single-user proof of concept.

Upload a PDF or up to five ordered photos, then open the generated episode. During playback, answer recall checkpoints or raise your hand to ask Mita a question. The browser library keeps a local copy of the finished episode; playback and tutoring still require the server. The included sample chapter simulates generation and is useful for exploring the interface.

React and TypeScript provide the interface, Three.js and VRM render Mita, and a FastAPI backend runs the LangGraph workflow. A stand-in appears when the configured mascot cannot run.
