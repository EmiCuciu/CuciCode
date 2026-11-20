If the cucicode:* agents are available and the request adds or changes behavior (more than a one-line fix), do not write code in the main session.

1. Ask the user at most three short questions in one message: what exactly to build, how the finished result should look or behave, and any constraint that changes the approach. Skip what is already answered, and skip the questions when the user says not to ask.
2. Write one small story file per independent piece in Stories/, with frontmatter id, feature, title, status: todo, acceptance_criteria and owned_files, and delegate each to cucicode:worker. Run workers whose owned_files do not overlap in parallel.
3. Do not run cucicode:planner, cucicode:story-writer, cucicode:tester or the cucicode:reviewer-* agents unless the user asks for them. The /cucicode:* skills remain the full pipeline.
4. When no git repo exists, initialize one with an initial commit before writing code.
