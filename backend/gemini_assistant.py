"""Planning assistant on Google Gemini, using the same tools and instructions as the Claude version."""
import json
import os

from google import genai
from google.genai import errors, types

try:
    from .assistant import MAX_TOOL_ROUNDS, SYSTEM_PROMPT, TOOLS, AssistantUnavailable, Handler
except ImportError:
    from assistant import MAX_TOOL_ROUNDS, SYSTEM_PROMPT, TOOLS, AssistantUnavailable, Handler

# Flash-Lite answers in seconds on the free tier; gemini-3.8-flash often hit 504 timeouts there.
DEFAULT_MODEL = 'gemini-3.5-flash-lite'
TIMEOUT_MS = 45000
BLOCKED = {'SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'}

FUNCTIONS = [types.FunctionDeclaration(name=t['name'], description=t['description'], parameters_json_schema=t['input_schema']) for t in TOOLS]


def has_key() -> bool:
    return bool(os.getenv('GEMINI_API_KEY') or os.getenv('GOOGLE_API_KEY'))


def _text(content) -> str:
    return ''.join(p.text for p in (content.parts or []) if getattr(p, 'text', None) and not getattr(p, 'thought', False)).strip()


async def ask(history: list[dict], handlers: dict[str, Handler], client=None) -> dict:
    """history: [{'role': 'user'|'assistant', 'text': str}], ending with the user's question."""
    model = os.getenv('GEMINI_MODEL', DEFAULT_MODEL)
    if client is None:
        if not has_key():
            raise AssistantUnavailable('Set GEMINI_API_KEY on the API service (free key from aistudio.google.com).')
        client = genai.Client(http_options=types.HttpOptions(timeout=TIMEOUT_MS))
    config = types.GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        tools=[types.Tool(function_declarations=FUNCTIONS)],
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    )
    contents = [types.Content(role='model' if t['role'] == 'assistant' else 'user', parts=[types.Part.from_text(text=t['text'])]) for t in history]
    calls = []
    try:
        for _ in range(MAX_TOOL_ROUNDS):
            response = await client.aio.models.generate_content(model=model, contents=contents, config=config)
            candidate = (response.candidates or [None])[0]
            reason = getattr(getattr(candidate, 'finish_reason', None), 'name', None) or str(getattr(candidate, 'finish_reason', '') or '')
            if candidate is None or candidate.content is None or reason in BLOCKED:
                return {'reply': 'I can’t help with that request. Ask about deployment, costs, air data or exposure.', 'tool_calls': calls, 'model': model}
            function_calls = response.function_calls or []
            if not function_calls:
                text = _text(candidate.content)
                if reason == 'MAX_TOKENS':
                    text += '\n\n(Reply truncated.)'
                return {'reply': text or 'No answer was produced.', 'tool_calls': calls, 'model': model}
            # Append the model turn unchanged so Gemini's thought signatures are preserved.
            contents.append(candidate.content)
            parts = []
            for call in function_calls:
                args = dict(call.args or {})
                calls.append({'name': call.name, 'input': args})
                handler = handlers.get(call.name)
                try:
                    if handler is None:
                        raise ValueError(f'Unknown tool {call.name}')
                    payload = {'result': json.loads(json.dumps(await handler(args), default=str))}
                except Exception as e:  # Report tool failures to the model instead of aborting the turn.
                    payload = {'error': str(e)}
                parts.append(types.Part(function_response=types.FunctionResponse(id=call.id, name=call.name, response=payload)))
            contents.append(types.Content(role='user', parts=parts))
        return {'reply': 'I stopped after too many tool steps. Try a narrower question.', 'tool_calls': calls, 'model': model}
    except errors.ClientError as e:
        if e.code in (400, 401, 403) and 'key' in str(e).lower():
            raise AssistantUnavailable('The GEMINI_API_KEY on the API service was rejected.') from e
        if e.code == 429:
            raise AssistantUnavailable('Gemini rate limit reached (free tier). Try again in a minute.') from e
        raise AssistantUnavailable(f'Gemini API error {e.code}.') from e
    except errors.ServerError as e:
        raise AssistantUnavailable('Gemini is busy or timed out. Try again in a moment.') from e
    except errors.APIError as e:
        raise AssistantUnavailable(f'Gemini API error {e.code}.') from e
