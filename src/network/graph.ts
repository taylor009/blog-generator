import { ResearcherAgent } from "../agents/researcherAgent";
import { RunnableSequence } from "@langchain/core/runnables";

interface GraphInput {
    topic: string;
}

interface GraphOutput {
    topic: string;
    searchResults: Array<{
        title: string;
        snippet: string;
        link: string;
    }>;
    summary: string;
}

export async function createBlogChain() {
    const researcherAgent = new ResearcherAgent();

    const chain = RunnableSequence.from([
        (input: GraphInput) => input,
        async (input: GraphInput): Promise<GraphOutput> => {
            const result = await researcherAgent.execute({
                topic: input.topic
            });
            
            return {
                topic: input.topic,
                searchResults: result.searchResults,
                summary: result.summary
            };
        }
    ]);

    return chain;
}

// Usage example:
// const chain = await createBlogChain();
// const result = await chain.invoke({
//     topic: "artificial intelligence trends 2024"
// });
