# 50 tasks from SWE-bench Verified, chosen by a published seed.
import json, random
from datasets import load_dataset
ds = load_dataset('princeton-nlp/SWE-bench_Verified', split='test')
rows = sorted(ds, key=lambda r: r['instance_id'])
random.seed(20261106)
picked = sorted(random.sample(rows, 50), key=lambda r: r['instance_id'])
keep = ['instance_id','repo','base_commit','problem_statement','hints_text','version']
with open('tasks-50.jsonl','w') as f:
    for r in picked: f.write(json.dumps({k: r[k] for k in keep})+'\n')
import collections
print(len(rows), 'total;', collections.Counter(r['repo'] for r in picked).most_common())
