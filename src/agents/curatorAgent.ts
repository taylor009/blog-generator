import type { BaseAgent } from "./baseAgent";
import { ChatOpenAI } from "@langchain/openai";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunTree } from "langsmith";

interface CurationInput {
  topic: string;
  searchResults: Array<{
    title: string;
    snippet: string;
    link: string;
  }>;
  summary: string;
}

interface CurationOutput {
  topic: string;
  selectedResults: Array<{
    title: string;
    snippet: string;
    link: string;
    relevanceScore: number;
    reason: string;
  }>;
  curatedSummary: string;
  suggestedAngles: string[];
}

export class CuratorAgent implements BaseAgent {
  id = "curator";
  name = "Content Curator";
  private model: ChatOpenAI;

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }

    this.model = new ChatOpenAI({
      modelName: "o1-mini",
      openAIApiKey: process.env.OPENAI_API_KEY,
    });
  }

  private async parseJSONSafely(jsonString: string): Promise<any> {
    try {
      // Try to parse the string directly
      return JSON.parse(jsonString);
    } catch (e) {
      // If direct parsing fails, try to extract JSON from the response
      const jsonMatch = jsonString.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch (e2) {
          throw new Error(`Failed to parse JSON response: ${jsonString}`);
        }
      }
      throw new Error(`No valid JSON found in response: ${jsonString}`);
    }
  }

  async execute(input: CurationInput): Promise<CurationOutput> {
    const runTree = new RunTree({
      name: "Curator Agent",
      run_type: "chain",
      project_name: "blog-bot",
      inputs: { topic: input.topic },
    });

    try {
      const outputParser = new StringOutputParser();

      // Score and filter the search results
      const scoringPrompt = `You are a content curator evaluating search results for a blog post about "${
        input.topic
      }". 
For each result, analyze its relevance, credibility, and uniqueness. Rate each on a scale of 0-10 and provide a brief reason.

You must respond with a valid JSON array containing objects with the following structure:
[
    {
        "title": "exact title from the result",
        "relevanceScore": number between 0 and 10,
        "reason": "brief explanation"
    },
    ...
]

Here are the results to evaluate:
${input.searchResults
  .map((r) => `Title: ${r.title}\nContent: ${r.snippet}\nURL: ${r.link}\n---`)
  .join("\n")}

Remember: Your entire response must be a valid JSON array.`;

      const scoringResponse = await this.model
        .pipe(outputParser)
        .invoke(scoringPrompt);

      const scoredResults = await this.parseJSONSafely(scoringResponse);

      if (!Array.isArray(scoredResults)) {
        throw new Error("Scoring response is not an array");
      }

      // Filter results and combine with original data
      const selectedResults = input.searchResults
        .map((result, index) => ({
          ...result,
          relevanceScore: scoredResults[index]?.relevanceScore ?? 0,
          reason: scoredResults[index]?.reason ?? "No reason provided",
        }))
        .filter((result) => result.relevanceScore >= 7) // Only keep high-scoring results
        .sort((a, b) => b.relevanceScore - a.relevanceScore);

      // Generate a curated summary and suggested angles
      const curationPrompt = `Based on these highly relevant search results about "${
        input.topic
      }", create a focused summary and suggest unique angles for the blog post.

You must respond with a valid JSON object using this exact structure:
{
    "curatedSummary": "your detailed summary here",
    "suggestedAngles": ["angle 1", "angle 2", "angle 3"]
}

Here are the selected results:
${selectedResults
  .map(
    (r) =>
      `Title: ${r.title}\nContent: ${r.snippet}\nRelevance: ${r.relevanceScore}\nReason: ${r.reason}\n---`
  )
  .join("\n")}

Remember: Your entire response must be a valid JSON object.`;

      const curationResponse = await this.model
        .pipe(outputParser)
        .invoke(curationPrompt);

      const curation = await this.parseJSONSafely(curationResponse);

      if (
        !curation.curatedSummary ||
        !Array.isArray(curation.suggestedAngles)
      ) {
        throw new Error("Invalid curation response format");
      }

      const output: CurationOutput = {
        topic: input.topic,
        selectedResults,
        curatedSummary: curation.curatedSummary,
        suggestedAngles: curation.suggestedAngles,
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
