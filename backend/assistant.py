"""Planning assistant: Claude answers questions by calling the platform's own models and data tools."""
import json
from typing import Awaitable, Callable

try:
    import anthropic
except ImportError:
    anthropic = None

MODEL = 'claude-opus-5-5'
MAX_TOOL_ROUNDS = 8

SYSTEM_PROMPT = """You are the planning assistant inside MOSS–ALGAE INDIA, a decision platform for placing two-stage moss + microalgae air biofilter pods in Bengaluru. Your users are city officials, CSR funders and hackathon judges.

Answer with numbers that come from your tools, never from memory. Call get_planner_state first whenever a question involves budgets, costs, sites, weights or pods, and reuse its current weights and economics inputs unless the user asks to change them.

Evidence rules:
- Say whether each figure is measured (OpenAQ stations, chamber sensors), modeled (Open-Meteo, the box model) or a team assumption (feasibility, equity, setup cost).
- Captured PM2.5 mass is not an ambient air-quality or health improvement. Never claim health benefits, lives saved or AQI change.
- If a tool reports missing configuration or an error, say what is missing and what the user can do.

Style: lead with the answer in one or two sentences, then the supporting numbers as a short list. Use Indian rupees with lakh/crore (₹4.5 L, ₹1.2 Cr). Always give PM2.5 with its unit (18 µg/m³) and dates in plain words (Sat 24 Oct, 6 pm). Refer to areas by name, not id. Keep replies under 180 words unless asked for detail."""

def _tool(name: str, description: str, properties: dict) -> dict:
    return {
        'name': name,
        'description': description,
        'strict': True,
        'input_schema': {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False},
    }

TOOLS = [
    _tool('get_planner_state', 'Current Planner configuration from the user’s screen: candidate areas with cost and the four 0–1 scores (cost efficiency, exposure, feasibility, equity), PM2.5, receptor counts, current weights, budget, pods per area, cost per pod, economics inputs and media efficiencies.', {}),
    _tool('optimize_deployment', 'Run the exact budget-constrained optimizer over the Planner candidates. Returns the selected areas, spend, total weighted score and how the selection shifts when each weight is raised by 20%.', {
        'budget_inr': {'type': 'number', 'description': 'Total budget in rupees.'},
        'weights': {'type': 'array', 'items': {'type': 'number'}, 'description': 'Four non-negative weights in order: cost efficiency, exposure, feasibility, equity.'},
    }),
    _tool('lifecycle_cost', 'Discounted lifecycle cost in rupees: capex plus discounted yearly energy and maintenance.', {
        'capex_inr': {'type': 'number'},
        'pods': {'type': 'integer'},
        'fan_watts_per_pod': {'type': 'number'},
        'full_power_hours_per_day': {'type': 'number'},
        'tariff_inr_per_kwh': {'type': 'number'},
        'maintenance_inr_per_pod_year': {'type': 'number'},
        'years': {'type': 'integer'},
        'discount_rate': {'type': 'number', 'description': 'Fraction, e.g. 0.08 for 8%.'},
    }),
    _tool('get_city_hotspots', 'Latest measured PM2.5 from OpenAQ stations within 25 km of Bengaluru with quality flags (stale, outlier) and hotspot status against NAAQS (60) and WHO (15) 24-hour limits.', {}),
    _tool('get_site_receptors', 'Schools, hospitals/clinics and bus stops within 500 m of each candidate area, from OpenStreetMap.', {}),
    _tool('get_site_air', 'Modeled current PM2.5 and the 72-hour forecast (peak, cleanest hour) for one candidate area from Open-Meteo.', {
        'site_id': {'type': 'string', 'enum': ['peenya', 'yeshwanthpur', 'majestic', 'hebbal', 'kr-puram', 'whitefield', 'silk-board', 'jayanagar', 'rr-nagar', 'vijayanagar', 'jp-nagar', 'sarjapur']},
    }),
]

Handler = Callable[[dict], Awaitable[dict]]

class AssistantUnavailable(Exception):
    pass

async def ask(history: list[dict], handlers: dict[str, Handler], client = None) -> dict:
    """history: [{'role': 'user'|'assistant', 'text': str}], ending with the user's question."""
    if anthropic is None:
        raise AssistantUnavailable('Anthropic python package not installed.')
    client = client or anthropic.AsyncAnthropic()
    messages: list = [{'role': turn['role'], 'content': turn['text']} for turn in history]
    calls = []
    try:
        for _ in range(MAX_TOOL_ROUNDS):
            response = await client.beta.messages.create(
                model=MODEL,
                max_tokens=16000,
                system=SYSTEM_PROMPT,
                tools=TOOLS,
                messages=messages,
                output_config={'effort': 'medium'},
                betas=['server-side-fallback-2026-07-01'],
                fallbacks='default',
            )
            if response.stop_reason == 'refusal':
                return {'reply': 'I can’t help with that request. Ask about deployment, costs, air data or exposure.', 'tool_calls': calls, 'model': response.model}
            messages.append({'role': 'assistant', 'content': response.content})
            if response.stop_reason == 'pause_turn':
                continue
            tool_uses = [b for b in response.content if b.type == 'tool_use']
            if response.stop_reason != 'tool_use' or not tool_uses:
                text = '\n'.join(b.text for b in response.content if b.type == 'text').strip()
                if response.stop_reason == 'max_tokens':
                    text += '\n\n(Reply truncated.)'
                return {'reply': text or 'No answer was produced.', 'tool_calls': calls, 'model': response.model}
            results = []
            for block in tool_uses:
                calls.append({'name': block.name, 'input': block.input})
                handler = handlers.get(block.name)
                try:
                    if handler is None:
                        raise ValueError(f'Unknown tool {block.name}')
                    output = await handler(dict(block.input))
                    results.append({'type': 'tool_result', 'tool_use_id': block.id, 'content': json.dumps(output, ensure_ascii=False, default=str)})
                except Exception as e:  # Report tool failures to the model instead of aborting the turn.
                    results.append({'type': 'tool_result', 'tool_use_id': block.id, 'content': f'Error: {e}', 'is_error': True})
            messages.append({'role': 'user', 'content': results})
        return {'reply': 'I stopped after too many tool steps. Try a narrower question.', 'tool_calls': calls, 'model': MODEL}
    except TypeError as e:
        # The SDK raises TypeError when no credential source (key, token or profile) resolves.
        if 'authentication' not in str(e):
            raise
        raise AssistantUnavailable('Set ANTHROPIC_API_KEY on the API service to enable the assistant.') from e
    except anthropic.AuthenticationError as e:
        raise AssistantUnavailable('The ANTHROPIC_API_KEY on the API service was rejected.') from e
    except anthropic.RateLimitError as e:
        raise AssistantUnavailable('The assistant is rate limited. Try again in a minute.') from e
    except anthropic.APIConnectionError as e:
        raise AssistantUnavailable('Could not reach the Claude API from the server.') from e
    except anthropic.APIStatusError as e:
        raise AssistantUnavailable(f'Claude API error {e.status_code}.') from e
