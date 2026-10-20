# Brief given to the naive agent, second dataset (2026-10-19)

This is the brief for the second-dataset rerun of the naive-agent test. The first run used dollarvote data; this one uses a public Stack Exchange dump so the inference thresholds (declared fields at 90% presence and 95% one type per batch, scalar projection at 10,000 rows, array-of-objects unwinding at 10,000 elements per key, scalars at nested object paths of up to three segments) are checked on data shaped by someone other than us. The sub-agent gets everything below the line and nothing else.

---

You are building the data layer for a small website on Hutch, a hosted document store for AI agents that you reach only through its MCP tools. You have never used Hutch before. Use its tools the way they describe themselves and make your own modelling decisions. Do not read any source code of Hutch, any design documents, any benchmark folders, or any earlier briefs or reports in `docs/storage-redesign/` (`naive-brief.md`, `naive-report.md`); the only things you may read are listed below.

## The product

Outdoors Reader is a read-only site for the Outdoors Stack Exchange question-and-answer community (hiking, camping, climbing, gear, safety). Users ask questions, other users answer them, anyone can comment on a question or an answer, and the question's asker can mark one answer as accepted. The site has three pages:

1. Tag board: for a chosen tag, rank users by the number of their answers that were accepted on questions carrying that tag, showing display name, reputation, accepted answers, total answers and total answer score in that tag.
2. Question page: one question's details (title, score, views, asker, tags, comment count) and its answers, each with author, author reputation, score, whether it is the accepted answer, and how many comments it has.
3. User page: one user's profile, badge counts, activity totals, their best answers and the tags they score most in.

Content is from Outdoors Stack Exchange (https://outdoors.stackexchange.com), Stack Exchange Data Dump 2024-04-02 (https://archive.org/details/stackexchange), licensed CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). Questions are at https://outdoors.stackexchange.com/questions/{question_id} and users at https://outdoors.stackexchange.com/users/{user_id}; a real site would link both.

## Source data

A Postgres database `naive2_source` on localhost (no password), read it with `psql naive2_source`. Treat it as read-only. Tables:

- users(user_id, display_name, reputation, location, website_url, about_me, views, up_votes, down_votes, creation_date, last_access_date, account_id) 19,991 rows
- questions(question_id, title, body, owner_user_id, owner_display_name, accepted_answer_id, score, view_count, answer_count, comment_count, favorite_count, creation_date, last_activity_date, last_edit_date, last_editor_user_id, closed_date, community_owned_date, content_license) 6,168 rows; body is HTML
- answers(answer_id, question_id, body, owner_user_id, owner_display_name, score, comment_count, creation_date, last_activity_date, last_edit_date, last_editor_user_id, community_owned_date, content_license) 15,078 rows; body is HTML
- tags(tag_id, tag_name, post_count) 551 rows
- question_tags(question_id, tag_name, position) 15,993 rows; position is the tag's order on the question
- comments(comment_id, post_id, user_id, user_display_name, score, text, creation_date) 44,726 rows; post_id is either a question_id or an answer_id (ids do not collide)
- badges(badge_id, user_id, name, class, tag_based, date) 46,670 rows; class is gold, silver or bronze
- votes(vote_id, post_id, vote_type, user_id, bounty_amount, creation_date) 185,098 rows; post_id is a question_id or an answer_id; vote_type is up, down, accepted, favorite, close, bounty_start and so on; voters are anonymous except for bounties
- post_links(link_id, post_id, related_post_id, link_type, creation_date) 2,379 rows; link_type is linked or duplicate

Business rules the pages need:

- An answer is accepted when `questions.accepted_answer_id` equals its `answer_id`. Questions with no accepted answer have a null `accepted_answer_id`.
- Some posts and comments belong to deleted accounts: `owner_user_id` (or `user_id` on comments) is null and only `owner_display_name` (or `user_display_name`) is set. Show that name where a page shows an author, with no reputation. Leave those answers out of the tag board.
- A question's tags are its rows in `question_tags`; a user is "in" a tag through answers to questions that carry the tag.
- Tag board ties: order by accepted answers, then total answer score in the tag (both descending), then display name.
- Answer lists are ordered by score descending, then creation_date ascending.

## Hutch

Hutch's MCP server runs at http://localhost:3114/api/mcp with bearer key `pr2-naive`. A command-line client is at scripts/mcp-cli.mts; run it from the repo root `/Users/michaelbuckbee/Sites/hutch/hutch-oss-wt-storage`. The client defaults to a different port, so always set `MCP_URL`:

    MCP_URL=http://localhost:3114/api/mcp MCP_API_KEY=pr2-naive npx tsx scripts/mcp-cli.mts list
    MCP_URL=http://localhost:3114/api/mcp MCP_API_KEY=pr2-naive npx tsx scripts/mcp-cli.mts call <tool> '<json args>'
    MCP_URL=http://localhost:3114/api/mcp MCP_API_KEY=pr2-naive npx tsx scripts/mcp-cli.mts call <tool> @/path/to/args.json

Start with `list` and read every tool description. That is all the documentation there is. You may write small scripts (Node or Python) to pull data out of Postgres and shape it into JSON for the Hutch tools. Keep each tool call's payload under 10 MB.

## Task

1. Decide how to organise this data as Hutch collections and documents. Choose the shape that seems most natural to you for a document store. Write down why.
2. Load it through the Hutch tools only.
3. Answer these with Hutch queries only (no SQL against the source database for answers): the tag board for tag "hiking" (top 10 users by accepted answers, each with display name, reputation, accepted answers, answers and total answer score in the tag); the question page for question_id 24498 (details, tags, asker name and reputation, number of comments on the question, and the first 10 answers with author, author reputation, score, accepted or not, and comment count); the user page for user_id 4148 (profile, gold/silver/bronze badge counts, number of questions, answers and accepted answers, the top 5 answers by score with their question titles, and the top 3 tags by total answer score). Where the answer needs calculation Hutch cannot do, do it in your script and say so.
4. For every Hutch query you run, record the wall-clock time the CLI prints, the `indexed` value if the response has one, and whether the first attempt worked or you had to reshape data or rephrase the query.

## Report

Write your report to `docs/storage-redesign/naive-report-2.md` in `/Users/michaelbuckbee/Sites/hutch/hutch-oss-wt-storage` and return it. Sections: the collections and document shapes you chose and why; load steps with counts and timings; each page query exactly as sent, its timing, indexed value, and the first three rows of the answer; what was confusing or missing in Hutch's tools; what you would want changed. Be concrete and honest; a failed first attempt is a finding, not a problem.
