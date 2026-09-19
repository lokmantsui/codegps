in a python project, a developer often needs to trace data flow from one point to another, jumping across functions in different files

if a starting point in code and an ending point in code is specified, can a tool output a path that connects the two points?

LLM coding agents (eg. claude) spends a lot of tokens reading a chain of files when asked a question. after the session ends, a new session answering a related question re-trace throught the same chain of files, wasting a lot of tokens

The goal of the project is to make a gps tool where user specifies point A and B in the code, an llm traces through the two points, building a path (nodes are code lines?) traced paths can be saved and reused by humans/agents in the future.