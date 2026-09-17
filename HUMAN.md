# Gametime Take Home State Machine

**Human** Matthew Haag / @muerl

## Stack and AI Choices

Having read through the problem I made what would be the two most influential choices at the beginning, choosing to use `TypeScript` (obviously) and `Codex` (less obviously).

The first choice `TypeScript` was with it being the primary full stack language I have used over the past 2.5 years it felt like the tool that I would be most able to evaluate the agentic output, and guide it with the tools freshest in my brain.

Choosing `Codex` was done for less clear reasons.  While I have worked primarily professionally in Cursor as my Agentic IDE, I wanted to experiment with a new and different tool for personal development.  OpenAI had an American Express offer, and so I decided to give it a try.

Beyond that selection, I did my best to approach this problem as a collaboration with the agent to meet the goals.  Leaning on the agents to do the heavy work and applying judgment to what it suggested.

Having spent the past 2.5 years working across TypeScript I know that Vercel, the company best known for being behind Next.js, as well as the evolving agent platform in Eve, and being a general thought leader in the space maintained a good collection of skills regarding TypeScript development.

`Postgres`  seemed the right tool for the back end due to its ubiquity and ease of use in cloud situations.  Further, having built small scale state machines in both `Postgres` and `MongoDB` in the past I found `Postgres` to be better suited to the task through its transaction mechanics and ACID guarantees.  

I have learned over the years that trying to roll your own ORM on top of a database is not ever the right path forward, and so the suggestion from the Agent of using Drizzle was accepted.

Finally, `Hono` was selected primarily for its simplicity and widespread use.  I wanted this work to be as lightweight and moveable as possible.  I worked under the assumption that the project would live as a part of a cluster of microservices with existing security rules and authentication protections, and such choices would live outside this project.

Clearly if the project was instead operating in a monolith the web surface would be replaced by whatever the rest of the monolith used.  In a more event driven system the changes could be triggered by events being read from queues as needed.  

## AI Process

The AI and I worked together, breaking apart the task into layers, building a plan, creating an initial implementation and then delivering feedback.  

I would stop it, push back on design choices and offer guidance and suggestions.  The AI did not consider all the edge cases, and often built things that I did not like the polish of at all.  

At the same time I appreciated its abilities to prototype as well to inform me of things that I may not have known, such as the row locking.  

## Tradeoffs 

I think the biggest tradeoff I made here is with regard to recoverability.  In the best of worlds, the state machine would send off the complicated and dangerous action such as Complete / Authorize / Void and have the results come back out of band rather than waiting for the values to be returned to it from a promise.  

This could be implemented through a combination of outbox patterns, event queues, and potentially webhooks. 

That would mean that if the state machine service went down while in the `payment_authorizing` state the response from the payment vendor or the delivery vendor would be far more likely to be waiting for processing when it came back rather than sitting in the database waiting for recovery. 

All of that being said, that is a much more complex system, one that would require much much more complex deploy infrastructure, and a higher cloud bill.

## Future goals with more time

With the clear understanding that many things, such as actual fulfilment and payment systems, are far out of scope, I think that I would have spent more time on trying to think through a way to reach the recoverability I would have preferred.  

Beyond that, I would have preferred to encode more transition rules in the type system. Time limited how far I explored advanced TypeScript types, and runtime validation would still be necessary for persisted state and external inputs.

Finally, while things wound up correctly in the `needs_attention` state, there was no proper alerting, or awareness for an outsider to investigate these.  Often data security rules would prevent direct access to the database, so giving DevOps QoL around these operational scenarios would have been a good addition.  