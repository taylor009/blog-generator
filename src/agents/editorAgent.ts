import type { BaseAgent } from "./baseAgent";
import { ChatOpenAI } from "@langchain/openai";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunTree } from "langsmith";

interface EditorInput {
  topic: string;
  title: string;
  content: string;
  metadata: {
    wordCount: number;
    readingTime: number;
    targetAudience: string;
    keyTakeaways: string[];
    sources: string[];
  };
  critique: {
    overallScore: number;
    feedback: {
      strengths: string[];
      weaknesses: string[];
      suggestions: string[];
    };
    contentIssues: Array<{
      type:
        | "structure"
        | "clarity"
        | "accuracy"
        | "style"
        | "seo"
        | "engagement";
      severity: "low" | "medium" | "high";
      location: string;
      issue: string;
      suggestion: string;
    }>;
    seoAnalysis: {
      keywordUsage: string;
      headingStructure: string;
      metaDescription: string;
      suggestedKeywords: string[];
    };
  };
}

interface EditorOutput {
  topic: string;
  title: string; // Potentially improved title
  content: string; // Improved content
  metadata: {
    wordCount: number;
    readingTime: number;
    targetAudience: string;
    keyTakeaways: string[];
    sources: string[];
    metaDescription: string; // Added from SEO analysis
    keywords: string[]; // Added from SEO analysis
  };
  changeLog: Array<{
    type: "title" | "content" | "structure" | "seo";
    description: string;
    before?: string;
    after?: string;
  }>;
}

export class EditorAgent implements BaseAgent {
  id = "editor";
  name = "Content Editor";
  private model: ChatOpenAI;

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }

    this.model = new ChatOpenAI({
      modelName: "o1-mini",
       // Balanced between creativity and consistency
      openAIApiKey: process.env.OPENAI_API_KEY,
    });
  }

  private async parseJSONSafely(jsonString: string): Promise<any> {
    try {
      return JSON.parse(jsonString);
    } catch (e) {
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

  private calculateReadingTime(content: string): number {
    const wordsPerMinute = 200;
    const wordCount = content.split(/\s+/).length;
    return Math.ceil(wordCount / wordsPerMinute);
  }

  async execute(input: EditorInput): Promise<EditorOutput> {
    const runTree = new RunTree({
      name: "Editor Agent",
      run_type: "chain",
      project_name: "blog-bot",
      inputs: { topic: input.topic },
    });

    try {
      const outputParser = new StringOutputParser();

      // First, plan the improvements based on critique
      const planningPrompt = `You are a professional content editor improving a blog post about "${
        input.topic
      }".
Review the critique and plan improvements to the content.

Current Title: ${input.title}
Target Audience: ${input.metadata.targetAudience}

Critique Overview:
- Overall Score: ${input.critique.overallScore}/10
- Strengths: ${input.critique.feedback.strengths.join(", ")}
- Weaknesses: ${input.critique.feedback.weaknesses.join(", ")}
- Suggestions: ${input.critique.feedback.suggestions.join(", ")}

Content Issues:
${input.critique.contentIssues
  .map(
    (issue) =>
      `- ${issue.type.toUpperCase()} (${issue.severity}): ${
        issue.issue
      }\n  Suggestion: ${issue.suggestion}`
  )
  .join("\n")}

SEO Analysis:
${JSON.stringify(input.critique.seoAnalysis, null, 2)}

Original Content:
${input.content}

You must respond with a valid JSON object using this exact structure:
{
    "improvementPlan": {
        "titleChanges": {
            "shouldChange": boolean,
            "reason": "reason for changing or keeping title",
            "newTitle": "new title if should change"
        },
        "structuralChanges": [
            {
                "type": "addition|modification|deletion",
                "location": "where in the content",
                "change": "what to change"
            }
        ],
        "styleImprovements": [
            "improvement 1",
            "improvement 2"
        ],
        "seoOptimizations": {
            "keywords": ["keyword 1", "keyword 2"],
            "metaDescription": "optimized meta description"
        }
    }
}

Remember: Your entire response must be a valid JSON object.`;

      const planningResponse = await this.model
        .pipe(outputParser)
        .invoke(planningPrompt);

      const plan = await this.parseJSONSafely(planningResponse);

      // Then, execute the improvements
      const editingPrompt = `You are improving a blog post based on the following improvement plan:
${JSON.stringify(plan, null, 2)}

Original Content:
${input.content}

You must respond with a valid JSON object using this exact structure:
{
    "title": "final title",
    "content": "improved content in markdown format",
    "keyTakeaways": ["key point 1", "key point 2", "key point 3"],
    "changeLog": [
        {
            "type": "title|content|structure|seo",
            "description": "what was changed",
            "before": "original text if applicable",
            "after": "new text if applicable"
        }
    ]
}

Guidelines:
1. Maintain the original voice and style while improving clarity
2. Ensure all changes align with the critique feedback
3. Optimize for both readability and SEO
4. Keep the content focused and engaging
5. Preserve valuable original content while fixing issues
6. Use markdown formatting appropriately

Remember: Your entire response must be a valid JSON object.`;

      const editingResponse = await this.model
        .pipe(outputParser)
        .invoke(editingPrompt);

      const improvements = await this.parseJSONSafely(editingResponse);

      // Calculate updated metadata
      const wordCount = improvements.content.split(/\s+/).length;
      const readingTime = this.calculateReadingTime(improvements.content);

      const output: EditorOutput = {
        topic: input.topic,
        title: improvements.title,
        content: improvements.content,
        metadata: {
          wordCount,
          readingTime,
          targetAudience: input.metadata.targetAudience,
          keyTakeaways: improvements.keyTakeaways,
          sources: input.metadata.sources,
          metaDescription:
            plan.improvementPlan.seoOptimizations.metaDescription,
          keywords: plan.improvementPlan.seoOptimizations.keywords,
        },
        changeLog: improvements.changeLog,
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
