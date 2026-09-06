# study-buddy

A family paper-practice context: confirmed schoolwork and wrong answers inform small Worksheets, and confirmed feedback informs the next selection. Games provide supplementary practice evidence; writing demonstrations support work on paper.

## Language

**Mistake Case** (错题案例):
The canonical record of one wrong-answer incident, keeping the original evidence (problem, the kid's wrong answer, error type, source). Cases are deduped per (child, problem, capture source).
_Avoid_: mistake (legacy table name), wrong-answer row

**Learning Attempt** (学习尝试):
One recorded attempt by the kid against a Mistake Case. Kinds: `original` (the first wrong answer), `correction` (re-solving the case), `reinforcement` (a similar generated problem), `review` (a delayed replay). History is never deleted.
_Avoid_: review record, try

**Correction Obligation** (订正义务):
The open teaching duty created together with a Mistake Case. It closes (`verified`) on the kid's first independent correct correction; it never accumulates counts.
_Avoid_: review task, reviewed_count, 3-correct cascade

**Closure Loop** (错题闭环):
The lifecycle every Mistake Case travels: capture → open Correction Obligation → correction attempts → reinforcement → delayed review waves. "Closing the loop" means a case reaches `verified` with its full attempt history preserved.
_Avoid_: mistake lifecycle, review pipeline

**Capture** (录入):
Bringing one wrong answer into the system from any source (game, manual typing, photo confirmation). Every Capture mode writes through the same Mistake Case write path; dedupe is scoped per (child, problem, capture source).
_Avoid_: intake, ingestion

**Source Event** (来源事件):
An immutable, provider-owned record of a learning fact, committed in the same transaction as the local write. External consumers read monotonic pages of Source Events; they never see raw chat, images, or credentials.
_Avoid_: outbox row, push message

**Worksheet** (纸质练习):
A selected set of exercises prepared for work on paper, with a stable identity and a fixed version once approved for printing. Its existence or printing does not establish that the child attempted it.
_Avoid_: daily obligation, app session

**Practice Round** (游戏练习轮):
One bounded set of game questions together with its first responses and subsequent retries. First-pass performance remains distinguishable from eventual completion.
_Avoid_: final accuracy, streak

**First-pass Accuracy** (首轮正确率):
The proportion of questions answered correctly on their first response in a Practice Round, reported with the number answered and the round's total question count. Later retries do not overwrite it.
_Avoid_: eventual accuracy, mastery percentage
