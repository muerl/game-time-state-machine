# Gametime Take Home State Machine

**Human** Matthew Haag / @haagmm

## Stack and AI Choices

Having read through the problem I made what would be the two most influencial choices at the beging, chosing to use `TypeScript` (oviously) and `Codex` (less oviosul)

The first choice `TypeScript` was with it being the primary full stack language I have used over the past 2.5 years it felt like the tool that I would be most able to evaluate the agentic out put, and guide it with the tools freshest in my brain.

Chosing `Codex` was done for less clear reasons.  While I have worked primarily profecionally in Cursor as my Agentic IDE, I wanted to expirment with a new and different tool for personal development.  Open AI had an American Express offer, and so I decided to give it a try.

Beyond that selection, I did my best to aproach this problem as a collaboration with the agent to meet the goals.  Leaning on the agents to do the heavy work and applying judgment to what it suggested.

Having spent the past 2.5 years working across TypeScript I know that Vercel, the company best known for being behind NextJs, as well as the evolving agent platform in Eve, and being a general thought leader in the space maintained a good collection of skills regarding TypeScript Devolpment.

`PostGres`  seemed the right tool for the back end due to it ubiquity and ease of use in cloud sitations.  Further, have built small scale state machines in both `PostGres` and `MongoDB` in the past I found `PostGres` to be better suited of the task through its transaction mechanics and ACID garentees.  

I have learned over the years that trying to roll your own ORM on top of a database is not ever the right path forward, and so the suggestion from the Agent of using Drizzle was accepted.

Finally, `Hono` was selected primarily for its simplicity and wide spread use.  I wanted this work to be as light weight and moveable as possible.  I worked under the assumption that the project would live as a part of a cluster of micro sevices in protected network, and so the bigger issues of the security of the web services could be ignored.

Clearly if the project was instead operating in a monolyth the web surface would be replaced by what ever the rest of the monolyth used.  In a more event driven system the changes coudl be triggered by events being read from queues as needed.  


## Tradeoffs 

I think the biggest trade off I made here is with regard to recoverability.  In the best of worlds, the state machine would send off the complicated and dangious action such as Complete / Authorize / Void and have the results come back out of band (webhook, Queue, etc) rather than waiting for the values to be returned to it from a promise.  

That would mean that if the state machine service went down while in the `authorizing` state the response from the payment vendor or the delivery vendor would be waiting for processing when it came back rather than sitting in the database waiting for recovery. 

All of that being said, that is much more complex system, one that would require much much more complex deploy infrastructure, and a higher cloud bill.

## Future goals with more time

With the clear understanding that many things, such as actual fulfilment and payment systems, are far out of scope, I think that I would have spent more time on trying to .. i am nto sure.
