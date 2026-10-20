import { describe, it, expect } from "vitest";
import { applyArrayOps, fieldHeads, fieldsCover, parseArrayOps, projectData } from "./projection";
import { ClientInputError } from "@/lib/errors/client-input-error";

const question = {
  title: "Q",
  score: 3,
  owner: { user_id: 7, name: "ann", badges: { gold: 1, silver: 2 } },
  answers: [
    { answer_id: 1, score: 5, body: "long", owner: { user_id: 9, name: "bob" } },
    { answer_id: 2, score: 9, body: "longer" },
    "stray scalar",
    { answer_id: 3, body: "no score" },
  ],
  tags: ["a", "b"],
};

describe("projectData", () => {
  it("keeps top-level keys and drops the rest", () => {
    expect(projectData(question, ["title", "tags"])).toEqual({ title: "Q", tags: ["a", "b"] });
  });

  it("reduces each element of an array of objects to the listed keys, combining sibling paths", () => {
    expect(projectData(question, ["title", "answers.answer_id", "answers.score"])).toEqual({
      title: "Q",
      answers: [{ answer_id: 1, score: 5 }, { answer_id: 2, score: 9 }, { answer_id: 3 }],
    });
  });

  it("descends through objects and through objects inside array elements", () => {
    expect(projectData(question, ["owner.badges.gold", "answers.owner.name"])).toEqual({
      owner: { badges: { gold: 1 } },
      answers: [{ owner: { name: "bob" } }, {}, {}],
    });
  });

  it("a whole key wins over paths below it, in either order", () => {
    expect(projectData(question, ["owner", "owner.name"])).toEqual({ owner: question.owner });
    expect(projectData(question, ["owner.name", "owner"])).toEqual({ owner: question.owner });
  });

  it("leaves out a path below a scalar, and a missing key", () => {
    expect(projectData(question, ["score.x", "nope"])).toEqual({});
  });

  it("keeps a top-level key that literally contains dots", () => {
    expect(projectData({ "a.b": 1, a: { b: 2 } }, ["a.b"])).toEqual({ "a.b": 1, a: { b: 2 } });
    expect(projectData({ "first name": "x" }, ["first name"])).toEqual({ "first name": "x" });
  });

  it("returns non-object data unchanged", () => {
    expect(projectData([1, 2], ["a"])).toEqual([1, 2]);
  });
});

describe("fieldHeads / fieldsCover", () => {
  it("names the top-level keys a projection needs", () => {
    expect(fieldHeads(["title", "answers.score", "answers.id"]).sort()).toEqual(["answers", "answers.id", "answers.score", "title"]);
  });

  it("covers a path when fields return it or something below or above it", () => {
    expect(fieldsCover(undefined, "answers")).toBe(true);
    expect(fieldsCover(["answers.score"], "answers")).toBe(true);
    expect(fieldsCover(["owner"], "owner.list")).toBe(true);
    expect(fieldsCover(["title"], "answers")).toBe(false);
  });
});

describe("array_sort / array_limit", () => {
  const voters = { votes: [{ name: "cy", pts: 2 }, { name: "al", pts: null }, { name: "bo", pts: 5 }, { pts: 5 }, { name: "Ab", pts: 1 }] };

  it("parses comma lists and arrays, and merges limit into the same path", () => {
    const ops = parseArrayOps({ votes: "-pts,name", "a.b": ["x", "-y.z"] }, { votes: 2 });
    expect(ops).toEqual([
      { path: "votes", sort: [{ segments: ["pts"], descending: true }, { segments: ["name"], descending: false }], limit: 2 },
      { path: "a.b", sort: [{ segments: ["x"], descending: false }, { segments: ["y", "z"], descending: true }] },
    ]);
  });

  it("rejects bad specs", () => {
    expect(() => parseArrayOps({ votes: 3 as unknown as string }, undefined)).toThrow(/must be a string/);
    expect(() => parseArrayOps({ votes: "a,b,c,d" }, undefined)).toThrow(/at most 3/);
    expect(() => parseArrayOps({ votes: "a,b,c,d" }, undefined)).toThrow(ClientInputError);
    expect(() => parseArrayOps({ "bad path": "a" }, undefined)).toThrow(/Invalid array_sort path/);
    expect(() => parseArrayOps(undefined, { votes: -1 })).toThrow(/whole number/);
    expect(() => parseArrayOps(undefined, { votes: 1.5 })).toThrow(/whole number/);
  });

  it("sorts ascending in code-point order with missing names last, keeping original order on ties", () => {
    const out = applyArrayOps(voters, parseArrayOps({ votes: "name" }, undefined)).data as typeof voters;
    expect(out.votes.map((v) => v.name ?? null)).toEqual(["Ab", "al", "bo", "cy", null]);
  });

  it("sorts descending numerically with nulls still last, then breaks ties on the next key", () => {
    const { data, totals } = applyArrayOps(voters, parseArrayOps({ votes: "-pts,name" }, { votes: 4 }));
    const out = data as typeof voters;
    expect(totals).toEqual({ votes: 5 });
    expect(out.votes).toEqual([{ name: "bo", pts: 5 }, { pts: 5 }, { name: "cy", pts: 2 }, { name: "Ab", pts: 1 }]);
  });

  it("limits without sorting, and leaves a document without the array alone", () => {
    expect(applyArrayOps(voters, parseArrayOps(undefined, { votes: 1 }))).toEqual({ data: { votes: [{ name: "cy", pts: 2 }] }, totals: { votes: 5 } });
    // A limit that cuts nothing reports no total.
    expect(applyArrayOps(voters, parseArrayOps(undefined, { votes: 9 })).totals).toEqual({});
    expect(applyArrayOps({ votes: "n/a" }, parseArrayOps(undefined, { votes: 1 }))).toEqual({ data: { votes: "n/a" }, totals: {} });
  });

  it("reaches an array below an object and never mutates the input", () => {
    const doc = { page: { items: [{ n: 2 }, { n: 1 }] } };
    expect(applyArrayOps(doc, parseArrayOps({ "page.items": "n" }, undefined)).data).toEqual({ page: { items: [{ n: 1 }, { n: 2 }] } });
    expect(doc.page.items[0].n).toBe(2);
  });
});
