import { createBlogChain } from "./src/network/graph";

async function main() {
    const chain = await createBlogChain();
    const result = await chain.invoke({
        topic: "artificial intelligence trends 2024"
    });
    
    console.log("Research Results:", result);
}

main().catch(console.error);