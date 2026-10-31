---
name: conversational-ai-flow
description: Design or implement chatbot dialogue flows, intent routing, slot filling, recovery, response payloads, and conversational UX.
---

# Conversational AI Flow Design

Use this skill when designing or implementing a conversational assistant's flow, dialogue states, intent routing, or recovery behavior. Shape the flow around the user's goal, make state transitions explicit, and keep each prompt tied to a clear next step.

## Conversation state

Track only context needed to continue the interaction: current intent, collected entities or slots, conversation history, flow position, and any confidence threshold used by the classifier. Update history and context together when processing a turn.

```python
class ConversationState:
    def __init__(self):
        self.current_intent = None
        self.entities = {}
        self.conversation_history = []
        self.flow_position = "start"
        self.confidence_threshold = 0.7

    def update_context(self, user_input, intent, entities):
        self.conversation_history.append({
            "user_input": user_input,
            "intent": intent,
            "entities": entities,
        })
        self.entities.update(entities)
        self.current_intent = intent
```

Adapt this sketch to the application's persistence, privacy, and state-management model; do not retain sensitive conversation content without a product need.

## Route by intent and fill required slots

Give each flow explicit entry conditions and ordered steps. Validate collected values before taking actions. If required information is missing, ask for one missing slot at a time; proceed when all required slots are present.

```yaml
flows:
  booking_flow:
    entry_conditions:
      - intent: book_appointment
    steps:
      - name: collect_datetime
        prompt: "When would you like to schedule?"
        validation: datetime_validator
      - name: confirm_booking
        prompt: "Confirm booking on {datetime}?"
        actions: [create_booking, send_confirmation]

  fallback_flow:
    triggers: [low_confidence, unknown_intent]
    strategy: clarification_questions
```

```python
def slot_filling_handler(state, required_slots):
    missing_slots = [slot for slot in required_slots if slot not in state.entities]
    if missing_slots:
        return generate_slot_prompt(missing_slots[0], state)
    return proceed_to_next_step(state)
```

For consequential actions, summarize the collected details and ask for confirmation before executing them. Make retries safe so repeated turns do not create duplicate actions.

## Recover from misunderstandings

Use progressive clarification: start with a brief request to rephrase, then offer a small set of likely choices, then hand off or explain the available alternative after repeated failures. Keep the recovery appropriate to the product; do not promise human handoff unless one exists.

```python
class ErrorRecovery:
    def handle_misunderstanding(self, state, attempt_count):
        strategies = {
            1: "I didn't quite catch that. Could you rephrase?",
            2: "Let me try differently. Are you looking to: [options]?",
            3: "I still can't resolve this. Here's how to get more help.",
        }
        return strategies.get(attempt_count, strategies[3])
```

## Generate contextual responses

Use response templates to keep confirmations and progress updates consistent while inserting only verified context. Summaries should state what has been collected and what happens next.

```python
class ResponseGenerator:
    templates = {
        "confirmation": [
            "Got it! {summary}. Is that correct?",
            "Let me confirm: {summary}. Does this look right?",
        ],
        "progress": [
            "Great! We've got {completed}. Next, {next_step}.",
            "Perfect! Just need {remaining} and we're done.",
        ],
    }
```

## Return rich or multimodal responses

When the channel supports UI components, keep the text useful on its own and attach structured options with stable payloads. Ensure every quick reply has an equivalent accessible text or keyboard path.

```json
{
  "response_type": "rich",
  "text": "Here are your options:",
  "components": [
    {
      "type": "quick_replies",
      "options": [
        {"title": "Schedule Appointment", "payload": "intent:book"},
        {"title": "Check Status", "payload": "intent:status"}
      ]
    }
  ]
}
```

## Measure flow quality

Track metrics that help identify friction, such as completion rate, average turns, fallback rate, and abandonment points. Define denominators and missing-data behavior before comparing metrics; avoid division by zero.

```python
def track_flow_metrics(conversation_id, metrics):
    return {
        "completion_rate": metrics.completed / metrics.started,
        "average_turns": metrics.total_turns / metrics.conversations,
        "fallback_rate": metrics.fallbacks / metrics.total_turns,
        "abandonment_points": identify_drop_off_points(conversation_id),
    }
```

## Design checklist

- Define the assistant's role and tone in terms that fit the product.
- Anticipate the next information the user will need to provide or receive.
- Summarize long interactions when it helps the user reorient.
- Cover success, invalid input, ambiguity, interruption, cancellation, and retry paths.
- Review conversation analytics and user feedback to find confusing or abandoned steps.
