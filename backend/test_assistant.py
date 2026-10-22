import asyncio
import os
import unittest
from types import SimpleNamespace as NS
from fastapi.testclient import TestClient
import json
from backend import gemini_assistant
from backend.assistant import ask
from backend.main import app, assistant_handlers

PLANNER = {
    'candidates': [
        {'id': 'majestic', 'cost': 220000, 'scores': [0.8, 1.0, 0.5, 0.7]},
        {'id': 'peenya', 'cost': 200000, 'scores': [0.9, 0.4, 0.7, 0.9]},
        {'id': 'jayanagar', 'cost': 185000, 'scores': [1.0, 0.6, 0.9, 0.4]},
    ],
    'pods_per_site': 4,
}

class FakeMessages:
    def __init__(self, responses):
        self.responses, self.requests = list(responses), []
    async def create(self, **kwargs):
        self.requests.append({**kwargs, 'messages': list(kwargs['messages'])})
        return self.responses.pop(0)

def fake_client(*responses):
    return NS(beta=NS(messages=FakeMessages(responses)))

class AssistantLoopTests(unittest.TestCase):
    def test_tool_round_trip(self):
        tool_call = NS(stop_reason='tool_use', model='claude-opus-5-5', content=[NS(type='tool_use', id='t1', name='optimize_deployment', input={'budget_inr': 450000, 'weights': [25, 35, 20, 20]})])
        final = NS(stop_reason='end_turn', model='claude-opus-5-5', content=[NS(type='text', text='Majestic and Jayanagar fit.')])
        client = fake_client(tool_call, final)
        result = asyncio.run(ask([{'role': 'user', 'text': 'Where with ₹4.5 L?'}], assistant_handlers(PLANNER), client))
        self.assertEqual(result['reply'], 'Majestic and Jayanagar fit.')
        self.assertEqual(result['tool_calls'][0]['name'], 'optimize_deployment')
        second = client.beta.messages.requests[1]['messages'][-1]['content'][0]
        self.assertEqual(second['tool_use_id'], 't1')
        self.assertNotIn('is_error', second)
        self.assertIn('Majestic', second['content'])

    def test_tool_error_is_reported_not_raised(self):
        tool_call = NS(stop_reason='tool_use', model='m', content=[NS(type='tool_use', id='t1', name='optimize_deployment', input={'budget_inr': 1, 'weights': [1]})])
        final = NS(stop_reason='end_turn', model='m', content=[NS(type='text', text='ok')])
        client = fake_client(tool_call, final)
        asyncio.run(ask([{'role': 'user', 'text': 'q'}], assistant_handlers(PLANNER), client))
        self.assertTrue(client.beta.messages.requests[1]['messages'][-1]['content'][0]['is_error'])

    def test_refusal_returns_message(self):
        client = fake_client(NS(stop_reason='refusal', model='m', content=[]))
        result = asyncio.run(ask([{'role': 'user', 'text': 'q'}], {}, client))
        self.assertIn('can’t help', result['reply'])

class AssistantHandlerTests(unittest.TestCase):
    def test_optimize_names_sites_and_reports_sensitivity(self):
        out = asyncio.run(assistant_handlers(PLANNER)['optimize_deployment']({'budget_inr': 450000, 'weights': [25, 35, 20, 20]}))
        self.assertLessEqual(out['spend_inr'], 450000)
        self.assertTrue(all(name in ('Majestic', 'Peenya', 'Jayanagar') for name in out['selected']))
        self.assertEqual(len(out['sensitivity']), 4)

    def test_missing_planner_state(self):
        out = asyncio.run(assistant_handlers(None)['optimize_deployment']({'budget_inr': 1, 'weights': [1, 1, 1, 1]}))
        self.assertIn('error', out)

    def test_lifecycle_cost(self):
        out = asyncio.run(assistant_handlers(None)['lifecycle_cost']({'capex_inr': 100000, 'pods': 4, 'fan_watts_per_pod': 40, 'full_power_hours_per_day': 24, 'tariff_inr_per_kwh': 8, 'maintenance_inr_per_pod_year': 5000, 'years': 1, 'discount_rate': 0}))
        self.assertEqual(out['annual_energy_kwh'], 1401.6)
        self.assertEqual(out['discounted_lifecycle_cost_inr'], round(100000 + 1401.6 * 8 + 20000))

    def test_endpoint_without_credentials_asks_for_gemini_key(self):
        keys = ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY')
        saved = {k: os.environ.pop(k) for k in keys if k in os.environ}
        try:
            response = TestClient(app).post('/api/assistant', json={'history': [{'role': 'user', 'text': 'hello'}]})
        finally:
            os.environ.update(saved)
        self.assertEqual(response.status_code, 503)
        self.assertIn('GEMINI_API_KEY', response.json()['detail'])

class FakeGeminiModels:
    def __init__(self, responses):
        self.responses, self.requests = list(responses), []
    async def generate_content(self, **kwargs):
        self.requests.append({**kwargs, 'contents': list(kwargs['contents'])})
        return self.responses.pop(0)

def gemini_response(parts, function_calls=None, finish='STOP'):
    content = NS(role='model', parts=parts)
    return NS(candidates=[NS(content=content, finish_reason=NS(name=finish))], function_calls=function_calls)

class GeminiLoopTests(unittest.TestCase):
    def test_tool_round_trip(self):
        call = NS(id='c1', name='optimize_deployment', args={'budget_inr': 450000, 'weights': [25, 35, 20, 20]})
        first = gemini_response([NS(text=None, function_call=call)], function_calls=[call])
        final = gemini_response([NS(text='Majestic and Jayanagar fit.', thought=False)])
        models = FakeGeminiModels([first, final])
        result = asyncio.run(gemini_assistant.ask([{'role': 'user', 'text': 'Where with ₹4.5 L?'}], assistant_handlers(PLANNER), NS(aio=NS(models=models))))
        self.assertEqual(result['reply'], 'Majestic and Jayanagar fit.')
        self.assertEqual(result['tool_calls'][0]['name'], 'optimize_deployment')
        sent = models.requests[1]['contents']
        self.assertIs(sent[1], first.candidates[0].content)
        reply = sent[2].parts[0].function_response
        self.assertEqual((reply.id, reply.name), ('c1', 'optimize_deployment'))
        self.assertIn('Majestic', json.dumps(reply.response['result']))

    def test_tool_error_is_reported_not_raised(self):
        call = NS(id='c1', name='optimize_deployment', args={'budget_inr': 1, 'weights': [1]})
        models = FakeGeminiModels([gemini_response([], function_calls=[call]), gemini_response([NS(text='ok')])])
        asyncio.run(gemini_assistant.ask([{'role': 'user', 'text': 'q'}], assistant_handlers(PLANNER), NS(aio=NS(models=models))))
        self.assertIn('error', models.requests[1]['contents'][-1].parts[0].function_response.response)

    def test_history_roles_map_to_gemini(self):
        models = FakeGeminiModels([gemini_response([NS(text='hi')])])
        history = [{'role': 'user', 'text': 'a'}, {'role': 'assistant', 'text': 'b'}, {'role': 'user', 'text': 'c'}]
        asyncio.run(gemini_assistant.ask(history, {}, NS(aio=NS(models=models))))
        self.assertEqual([c.role for c in models.requests[0]['contents']], ['user', 'model', 'user'])

    def test_safety_block_returns_message(self):
        models = FakeGeminiModels([gemini_response([], finish='SAFETY')])
        result = asyncio.run(gemini_assistant.ask([{'role': 'user', 'text': 'q'}], {}, NS(aio=NS(models=models))))
        self.assertIn('can’t help', result['reply'])

if __name__ == '__main__':
    unittest.main()
