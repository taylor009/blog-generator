import type { BaseAgent } from "./baseAgent";
import { Tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunTree } from "langsmith";


interface ResearchInput {
    topic: string;
    numResults?: number;
}

interface ResearchOutput {
    topic: string;
    searchResults: Array<{
        title: string;
        snippet: string;
        link: string;
    }>;
    summary: string;
}

interface TavilyResult {
    title: string;
    content: string;
    url: string;
}

export class ResearcherAgent implements BaseAgent {
    id = "researcher";
    name = "Topic Researcher";
    private searchTool: TavilySearchResults;
    private model: ChatOpenAI;

    constructor() {
        if (!process.env.TAVILY_API_KEY) {
            throw new Error("TAVILY_API_KEY environment variable is not set");
        }
        if (!process.env.OPENAI_API_KEY) {
            throw new Error("OPENAI_API_KEY environment variable is not set");
        }

        this.searchTool = new TavilySearchResults({
            apiKey: process.env.TAVILY_API_KEY,
            maxResults: 5,
            includeRawContent: false,
            includeImages: false
        });

        this.model = new ChatOpenAI({
            modelName: "o1-mini",
            openAIApiKey: process.env.OPENAI_API_KEY,
        });
    }

    async execute(input: ResearchInput): Promise<ResearchOutput> {
        const runTree = new RunTree({
            name: "Research Agent",
            run_type: "chain",
            project_name: "blog-bot",
            inputs: { topic: input.topic }
        });

        try {
            const numResults = input.numResults || 5;

            // Perform Tavily search
            const searchResponse = await this.searchTool.invoke(
                `${input.topic} blog article research`
            );

            // Parse and structure the search results
            const searchResults = (Array.isArray(searchResponse.results) ? searchResponse.results : [])
                .slice(0, numResults)
                .map((result: TavilyResult) => ({
                    title: result.title,
                    snippet: result.content,
                    link: result.url
                }));

            // Generate a summary using the model
            const summaryPrompt = `Based on these search results about "${input.topic}", provide a comprehensive summary that could be used as research for writing a blog post:\n\n${searchResults
                .map((r: { title: string; snippet: string }) => `${r.title}\n${r.snippet}\n`)
                .join("\n")}`;

            const outputParser = new StringOutputParser();
            const summary = await this.model
                .pipe(outputParser)
                .invoke(summaryPrompt);

            const output = {
                topic: input.topic,
                searchResults,
                summary,
            };

            runTree.end({ outputs: output });
            await runTree.postRun();

            return output;
        } catch (error) {
            runTree.end({ error });
            await runTree.postRun();
            throw error;
        }
    }
}