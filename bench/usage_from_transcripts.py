"""Sum per-run token usage from Claude Code transcripts written by the SDK-spawned CLI.

Usage: python _usage_from_transcripts.py <since 'YYYY-MM-DD HH:MM' local> [config_dir]
Default config_dir = C:\\tmp\\claude-cfg-credit (isolated dir used by _phase3_run_op.ps1).
Prints one line per transcript: agent dir, model(s), token breakdown, cost at list price.
No secrets are read or printed.
"""
import collections, glob, json, os, sys, time

PRICE = {  # $/MTok input, output. cache write = 1.25x input (5m), cache read = 0.1x input
    'claude-haiku-4-5-20251001': (1, 5), 'claude-haiku-4-5': (1, 5),
    'claude-sonnet-4-6': (3, 15), 'claude-sonnet-5': (2, 10),
    'claude-opus-4-7': (5, 25), 'claude-opus-4-8': (5, 25), 'claude-opus-5': (5, 25),
}

since = time.mktime(time.strptime(sys.argv[1], '%Y-%m-%d %H:%M'))
cfg = sys.argv[2] if len(sys.argv) > 2 else r'C:\tmp\claude-cfg-credit'
grand = collections.Counter(); grand_cost = 0.0
for f in sorted(glob.glob(os.path.join(cfg, 'projects', '**', '*.jsonl'), recursive=True)):
    if os.path.getmtime(f) < since:
        continue
    tot = collections.Counter(); models = collections.Counter(); cost = 0.0
    for line in open(f, encoding='utf-8', errors='ignore'):
        try:
            j = json.loads(line)
        except ValueError:
            continue
        m = j.get('message') or {}
        u = m.get('usage') if isinstance(m, dict) else None
        if not u:
            continue
        mod = m.get('model'); models[mod] += 1
        i, o = PRICE.get(mod, (0, 0))
        cost += (u.get('input_tokens', 0) * i + u.get('output_tokens', 0) * o
                 + u.get('cache_creation_input_tokens', 0) * i * 1.25
                 + u.get('cache_read_input_tokens', 0) * i * 0.1) / 1e6
        for k in ('input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'):
            tot[k] += u.get(k, 0) or 0
    grand.update(tot); grand_cost += cost
    print(os.path.basename(os.path.dirname(f)), '| msgs=', sum(models.values()), 'models=', dict(models))
    print('   ', dict(tot), '| cost_at_list=%.4f' % cost)
print('TOTAL', dict(grand), '| cost_at_list=%.4f' % grand_cost)
