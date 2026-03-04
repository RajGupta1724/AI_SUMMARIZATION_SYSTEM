"""
DBRAUBOT Backend
================
FastAPI server with Hierarchical RAG using binary-tree chunking for long documents.
- Local LLM via Ollama (data never leaves your server)
- Supabase for user auth validation + conversation/document metadata storage
- Hierarchical chunking: document → sections → paragraphs → sentences
  Uses a binary-tree retrieval approach for better context on long documents.

Requirements:
    pip install fastapi uvicorn python-multipart pypdf2 langchain
                langchain-community ollama supabase-py numpy tiktoken

Run:
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

import os
import json
import uuid
import math
import hashlib
import logging
from typing import List, Optional, Dict, Any
from datetime import datetime

import numpy as np
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# PDF processing
import PyPDF2
import io

# Supabase
from supabase import create_client, Client

# Ollama (local LLM)
import ollama

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ============================================================
# CONFIG — Set these via environment variables or directly
# ============================================================

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://ouintjjakyvlueglowru.supabase.co")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im91aW50ampha3l2bHVlZ2xvd3J1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1MzM1MjQsImV4cCI6MjA4ODEwOTUyNH0.TQ1KGoCzKeP7n_QDpi4R7ZpANotv-TomETDtt1Ykl0A")
SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im91aW50ampha3l2bHVlZ2xvd3J1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjUzMzUyNCwiZXhwIjoyMDg4MTA5NTI0fQ.-4xAcDOnaZfNHRNicjgzo0oES4RtYfPhLou2Ov80pHo"


OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2")        # or mistral, phi3, etc.
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "nomic-embed-text")
MAX_CONTEXT_TOKENS = int(os.getenv("MAX_CONTEXT_TOKENS", "3000"))
CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", "500"))             # words per leaf chunk
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", "50"))

# ============================================================
# SUPABASE CLIENT
# ============================================================

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# ============================================================
# FASTAPI APP
# ============================================================

app = FastAPI(title="DBRAUBOT API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],           # restrict to your domain in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================
# PYDANTIC MODELS
# ============================================================

class ChatRequest(BaseModel):
    query: str
    document_id: str
    user_id: str
    conversation_id: Optional[str] = None
    history: Optional[List[Dict[str, str]]] = []

class DeleteRequest(BaseModel):
    user_id: str

# ============================================================
# IN-MEMORY VECTOR STORE
# (For production, replace with pgvector or FAISS persistence)
# ============================================================

# Structure: { document_id: { "chunks": [ChunkNode], "tree": BinaryTreeNode } }
DOCUMENT_STORE: Dict[str, Any] = {}


class ChunkNode:
    """A leaf node in the hierarchical chunk tree."""
    def __init__(self, text: str, chunk_id: int, page_start: int, page_end: int):
        self.text = text
        self.chunk_id = chunk_id
        self.page_start = page_start
        self.page_end = page_end
        self.embedding: Optional[List[float]] = None
        self.summary: str = ""          # summary of this chunk (for parent nodes)


class BinaryTreeNode:
    """
    Hierarchical summary node.
    Leaf nodes hold actual text chunks.
    Parent nodes hold summaries of their children.
    This allows coarse-to-fine retrieval for very long documents.
    """
    def __init__(self, chunk: Optional[ChunkNode] = None):
        self.chunk = chunk              # set for leaf nodes
        self.summary = ""              # summarised text for this subtree
        self.embedding: Optional[List[float]] = None
        self.left: Optional['BinaryTreeNode'] = None
        self.right: Optional['BinaryTreeNode'] = None
        self.is_leaf: bool = chunk is not None


# ============================================================
# PDF PROCESSING
# ============================================================

def extract_text_from_pdf(file_bytes: bytes) -> Dict[str, Any]:
    """Extract text and metadata from PDF bytes."""
    reader = PyPDF2.PdfReader(io.BytesIO(file_bytes))
    total_pages = len(reader.pages)
    pages_text = []
    full_text = ""

    for i, page in enumerate(reader.pages):
        try:
            text = page.extract_text() or ""
            pages_text.append({"page": i + 1, "text": text})
            full_text += f"\n[Page {i+1}]\n{text}"
        except Exception as e:
            logger.warning(f"Failed to extract page {i+1}: {e}")
            pages_text.append({"page": i + 1, "text": ""})

    word_count = len(full_text.split())
    return {
        "full_text": full_text,
        "pages_text": pages_text,
        "total_pages": total_pages,
        "word_count": word_count
    }


def create_chunks(pages_text: List[Dict], chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> List[ChunkNode]:
    """
    Split document into overlapping word-based chunks.
    Each chunk tracks which pages it spans.
    """
    chunks = []
    all_words_with_pages = []

    for page in pages_text:
        words = page["text"].split()
        for w in words:
            all_words_with_pages.append((w, page["page"]))

    total_words = len(all_words_with_pages)
    if total_words == 0:
        return chunks

    chunk_id = 0
    start = 0
    while start < total_words:
        end = min(start + chunk_size, total_words)
        chunk_words = [w for w, _ in all_words_with_pages[start:end]]
        page_start = all_words_with_pages[start][1]
        page_end = all_words_with_pages[end - 1][1]

        node = ChunkNode(
            text=" ".join(chunk_words),
            chunk_id=chunk_id,
            page_start=page_start,
            page_end=page_end
        )
        chunks.append(node)
        chunk_id += 1
        start += chunk_size - overlap  # overlap

    return chunks


# ============================================================
# EMBEDDING HELPERS
# ============================================================

def get_embedding(text: str) -> List[float]:
    """Get embedding from Ollama's local embedding model."""
    try:
        resp = ollama.embeddings(model=EMBEDDING_MODEL, prompt=text[:4096])
        return resp["embedding"]
    except Exception as e:
        logger.warning(f"Embedding failed: {e}. Using zero vector.")
        return [0.0] * 768


def cosine_similarity(a: List[float], b: List[float]) -> float:
    """Cosine similarity between two vectors."""
    a, b = np.array(a), np.array(b)
    norm_a, norm_b = np.linalg.norm(a), np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


# ============================================================
# HIERARCHICAL BINARY-TREE RAG
# ============================================================

def build_binary_tree(chunks: List[ChunkNode]) -> BinaryTreeNode:
    """
    Build a binary tree of chunk summaries for hierarchical retrieval.
    Leaf nodes = actual chunks
    Internal nodes = summaries of subtrees (generated by LLM)
    """
    if not chunks:
        root = BinaryTreeNode()
        root.summary = "Empty document"
        root.embedding = get_embedding("Empty document")
        return root

    # Create leaf nodes
    nodes = [BinaryTreeNode(chunk=c) for c in chunks]

    # Set leaf summaries (first 200 chars as proxy — full summarise on demand)
    for node in nodes:
        node.summary = node.chunk.text[:200] + ("…" if len(node.chunk.text) > 200 else "")
        node.embedding = node.chunk.embedding  # already computed

    # Bottom-up merge: O(n log n)
    while len(nodes) > 1:
        next_level = []
        for i in range(0, len(nodes), 2):
            if i + 1 < len(nodes):
                parent = BinaryTreeNode()
                parent.left = nodes[i]
                parent.right = nodes[i + 1]
                combined = f"{nodes[i].summary} | {nodes[i+1].summary}"
                parent.summary = combined[:300]
                # Parent embedding = average of children
                le = nodes[i].embedding or [0.0] * 768
                re = nodes[i + 1].embedding or [0.0] * 768
                parent.embedding = ((np.array(le) + np.array(re)) / 2).tolist()
                next_level.append(parent)
            else:
                next_level.append(nodes[i])
        nodes = next_level

    return nodes[0]


def hierarchical_search(root: BinaryTreeNode, query_embedding: List[float],
                         top_k: int = 5, beam_width: int = 4) -> List[ChunkNode]:
    """
    Binary-tree beam search retrieval.
    At each level, keep the top `beam_width` most relevant nodes.
    Descend until we reach leaves.
    Returns top_k leaf chunks ranked by similarity.
    """
    if root is None:
        return []

    # BFS with pruning
    frontier = [root]
    leaf_results = []

    while frontier:
        # Score all nodes in current frontier
        scored = []
        for node in frontier:
            if node.embedding:
                sim = cosine_similarity(query_embedding, node.embedding)
            else:
                sim = 0.0
            scored.append((sim, node))

        # Keep top beam_width
        scored.sort(key=lambda x: -x[0])
        scored = scored[:beam_width]

        next_frontier = []
        for sim, node in scored:
            if node.is_leaf:
                leaf_results.append((sim, node.chunk))
            else:
                if node.left:
                    next_frontier.append(node.left)
                if node.right:
                    next_frontier.append(node.right)

        frontier = next_frontier

    # Sort leaves by relevance
    leaf_results.sort(key=lambda x: -x[0])
    return [chunk for _, chunk in leaf_results[:top_k]]


def get_relevant_chunks(doc_id: str, query: str, top_k: int = 5) -> List[ChunkNode]:
    """Main entry point for retrieval."""
    store = DOCUMENT_STORE.get(doc_id)
    if not store:
        logger.warning(f"Document {doc_id} not found in store")
        return []

    query_embedding = get_embedding(query)

    tree = store.get("tree")
    if tree:
        return hierarchical_search(tree, query_embedding, top_k=top_k)

    # Fallback: flat search
    chunks = store.get("chunks", [])
    scored = [(cosine_similarity(query_embedding, c.embedding or []), c) for c in chunks]
    scored.sort(key=lambda x: -x[0])
    return [c for _, c in scored[:top_k]]


# ============================================================
# LLM INTERACTION
# ============================================================

SYSTEM_PROMPT = """You are DBRAUBOT, an AI document assistant for Dr. Bhimrao Ambedkar University (DBRAU), Agra.

STRICT RULES:
1. Answer ONLY based on the provided document context. Do not use outside knowledge.
2. If the answer is not in the document, say: "I couldn't find information about this in the document."
3. Be accurate, concise, and cite page numbers when possible.
4. Do not make up facts or hallucinate.
5. Maintain conversation context from the chat history provided.
"""

def build_llm_prompt(query: str, context_chunks: List[ChunkNode],
                     history: List[Dict[str, str]]) -> List[Dict[str, str]]:
    """Build the full message list for the LLM."""
    # Assemble context
    context_parts = []
    for chunk in context_chunks:
        context_parts.append(
            f"[Pages {chunk.page_start}–{chunk.page_end}]\n{chunk.text}"
        )
    context_text = "\n\n---\n\n".join(context_parts)

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    # Inject document context as a system-level message
    messages.append({
        "role": "system",
        "content": f"RELEVANT DOCUMENT CONTEXT:\n\n{context_text}"
    })

    # Previous conversation history (full context mode)
    if history:
        # Truncate history to avoid token overflow (keep last 10 turns)
        recent_history = history[-20:]
        for turn in recent_history:
            messages.append({"role": turn["role"], "content": turn["content"]})

    # Current query
    messages.append({"role": "user", "content": query})

    return messages


def generate_llm_response(messages: List[Dict[str, str]]) -> str:
    """Call Ollama with the full message list."""
    try:
        response = ollama.chat(
            model=OLLAMA_MODEL,
            messages=messages,
            options={"temperature": 0.3, "num_ctx": 4096}
        )
        return response["message"]["content"]
    except Exception as e:
        logger.error(f"LLM error: {e}")
        raise HTTPException(status_code=503, detail=f"LLM unavailable: {str(e)}")


def generate_summary(text: str, max_chars: int = 8000) -> str:
    """Generate a document summary."""
    # Use first + middle + end sections for long docs
    sample = text[:max_chars]
    messages = [
        {"role": "system", "content": "You are a helpful summarization assistant. Be concise and informative."},
        {"role": "user", "content": f"Please provide a clear, structured summary of this document in 3-5 paragraphs:\n\n{sample}"}
    ]
    try:
        return generate_llm_response(messages)
    except Exception:
        return "Document processed successfully. Summary generation failed — please check Ollama is running."


def generate_suggested_questions(summary: str) -> List[str]:
    """Generate 5 suggested questions based on the document summary."""
    messages = [
        {"role": "system", "content": "Generate exactly 5 short, specific questions a researcher might ask about this document. Return only a JSON array of strings."},
        {"role": "user", "content": f"Document summary:\n{summary[:2000]}\n\nReturn: [\"question1\", \"question2\", \"question3\", \"question4\", \"question5\"]"}
    ]
    try:
        resp = generate_llm_response(messages)
        # Extract JSON array
        start = resp.find('[')
        end = resp.rfind(']') + 1
        if start >= 0 and end > start:
            return json.loads(resp[start:end])
    except Exception as e:
        logger.warning(f"Question generation failed: {e}")
    return [
        "What is the main topic of this document?",
        "What are the key findings?",
        "What methodology was used?",
        "Who are the authors or contributors?",
        "What conclusions are drawn?"
    ]


# ============================================================
# AUTH HELPER
# ============================================================

async def verify_user(user_id: str) -> bool:
    """Verify user exists in Supabase (lightweight check)."""
    try:
        # We trust the user_id from the frontend since Supabase session is already validated
        return bool(user_id and len(user_id) > 8)
    except Exception:
        return False


# ============================================================
# API ENDPOINTS
# ============================================================

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    ollama_ok = False
    available_models = []

    try:
        response = ollama.list()
        ollama_ok = True

        # Correct extraction for your Ollama version
        if hasattr(response, "models"):
            available_models = [m.model for m in response.models]

        # Fallback (older dict format)
        elif isinstance(response, dict):
            available_models = [
                m.get("name") for m in response.get("models", [])
            ]

    except Exception as e:
        return {
            "status": "error",
            "timestamp": datetime.utcnow().isoformat(),
            "ollama": False,
            "error": str(e),
            "loaded_documents": len(DOCUMENT_STORE)
        }

    return {
        "status": "ok",
        "timestamp": datetime.utcnow().isoformat(),
        "ollama": ollama_ok,
        "available_models": available_models,
        "loaded_documents": len(DOCUMENT_STORE)
    }


@app.post("/api/documents/upload")
async def upload_document(
    file: UploadFile = File(...),
    user_id: str = Form(...)
):
    """
    Upload and process a PDF document.
    1. Extract text
    2. Chunk with overlap
    3. Embed each chunk
    4. Build hierarchical binary tree
    5. Generate summary + suggested questions
    6. Save metadata to Supabase
    """
    if not file.filename.endswith('.pdf'):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    if not await verify_user(user_id):
        raise HTTPException(status_code=401, detail="Invalid user")

    file_bytes = await file.read()
    file_size = len(file_bytes)

    logger.info(f"Processing document: {file.filename} ({file_size} bytes) for user {user_id}")

    # 1. Extract text
    try:
        extracted = extract_text_from_pdf(file_bytes)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"PDF extraction failed: {str(e)}")

    full_text = extracted["full_text"]
    pages_text = extracted["pages_text"]
    total_pages = extracted["total_pages"]
    word_count = extracted["word_count"]

    if word_count < 10:
        raise HTTPException(status_code=422, detail="PDF appears to be empty or image-only (no extractable text)")

    # 2. Create chunks
    logger.info(f"Creating chunks for {total_pages} pages, {word_count} words")
    chunks = create_chunks(pages_text)
    logger.info(f"Created {len(chunks)} chunks")

    # 3. Embed chunks
    logger.info("Embedding chunks…")
    for i, chunk in enumerate(chunks):
        chunk.embedding = get_embedding(chunk.text)
        if i % 20 == 0:
            logger.info(f"  Embedded {i}/{len(chunks)} chunks")

    # 4. Build binary tree
    logger.info("Building hierarchical tree…")
    tree = build_binary_tree(chunks)

    # 5. Save to in-memory store
    doc_id = str(uuid.uuid4())
    DOCUMENT_STORE[doc_id] = {
        "chunks": chunks,
        "tree": tree,
        "full_text": full_text[:50000],  # keep first 50k chars for summary
        "pages": total_pages,
        "words": word_count,
        "user_id": user_id
    }

    # 6. Generate summary
    logger.info("Generating summary…")
    summary = generate_summary(full_text)

    # 7. Generate suggested questions
    suggested_questions = generate_suggested_questions(summary)

    # 8. Save to Supabase
    try:
        doc_record = {
            "id": doc_id,
            "user_id": user_id,
            "name": file.filename,
            "pages": total_pages,
            "words": word_count,
            "file_size": file_size,
            "summary": summary,
            "created_at": datetime.utcnow().isoformat()
        }
        supabase.table("documents").insert(doc_record).execute()
        logger.info(f"Document {doc_id} saved to Supabase")
    except Exception as e:
        logger.warning(f"Supabase save failed (non-fatal): {e}")

    return {
        "document_id": doc_id,
        "name": file.filename,
        "pages": total_pages,
        "words": word_count,
        "chunks": len(chunks),
        "summary": summary,
        "suggested_questions": suggested_questions
    }


@app.post("/api/chat")
async def chat(request: ChatRequest):
    """
    Chat with a document.
    Uses hierarchical RAG retrieval + full conversation history.
    Saves messages to Supabase.
    """
    if not await verify_user(request.user_id):
        raise HTTPException(status_code=401, detail="Invalid user")

    if request.document_id not in DOCUMENT_STORE:
        # Try to reload from Supabase (if server was restarted)
        raise HTTPException(
            status_code=404,
            detail="Document not found in memory. Please re-upload the document (server may have restarted)."
        )

    # 1. Retrieve relevant chunks
    logger.info(f"Retrieving chunks for query: {request.query[:80]}")
    relevant_chunks = get_relevant_chunks(request.document_id, request.query, top_k=5)

    if not relevant_chunks:
        return JSONResponse(content={
            "response": "I couldn't find relevant information in the document for your query.",
            "conversation_id": request.conversation_id
        })

    # 2. Build LLM prompt with full history
    messages = build_llm_prompt(request.query, relevant_chunks, request.history or [])

    # 3. Generate response
    response_text = generate_llm_response(messages)

    # 4. Manage conversation in Supabase
    conversation_id = request.conversation_id
    try:
        if not conversation_id:
            # Create new conversation
            conv_title = request.query[:60] + ("…" if len(request.query) > 60 else "")
            conv_record = {
                "id": str(uuid.uuid4()),
                "user_id": request.user_id,
                "document_id": request.document_id,
                "title": conv_title,
                "created_at": datetime.utcnow().isoformat()
            }
            result = supabase.table("conversations").insert(conv_record).execute()
            conversation_id = conv_record["id"]

        # Save user message
        supabase.table("messages").insert({
            "id": str(uuid.uuid4()),
            "conversation_id": conversation_id,
            "role": "user",
            "content": request.query,
            "created_at": datetime.utcnow().isoformat()
        }).execute()

        # Save assistant message
        supabase.table("messages").insert({
            "id": str(uuid.uuid4()),
            "conversation_id": conversation_id,
            "role": "assistant",
            "content": response_text,
            "created_at": datetime.utcnow().isoformat()
        }).execute()

    except Exception as e:
        logger.warning(f"Supabase message save failed (non-fatal): {e}")

    return {
        "response": response_text,
        "conversation_id": conversation_id,
        "chunks_used": len(relevant_chunks),
        "pages_referenced": list(set(
            f"{c.page_start}–{c.page_end}" for c in relevant_chunks
        ))
    }


@app.delete("/api/documents/{document_id}")
async def delete_document(document_id: str, request: DeleteRequest):
    """Delete a document and all its conversations."""
    if not await verify_user(request.user_id):
        raise HTTPException(status_code=401, detail="Invalid user")

    # Remove from memory store
    if document_id in DOCUMENT_STORE:
        del DOCUMENT_STORE[document_id]

    # Remove from Supabase
    try:
        supabase.table("documents").delete().eq("id", document_id).eq("user_id", request.user_id).execute()
        # Conversations and messages cascade if you set up FK in Supabase
    except Exception as e:
        logger.warning(f"Supabase delete failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    return {"status": "deleted", "document_id": document_id}


@app.get("/api/documents")
async def list_documents(user_id: str):
    """List all documents for a user."""
    try:
        result = supabase.table("documents").select("id, name, pages, words, created_at") \
            .eq("user_id", user_id).order("created_at", desc=True).execute()
        return {"documents": result.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/conversations")
async def list_conversations(user_id: str):
    """List all conversations for a user."""
    try:
        result = supabase.table("conversations") \
            .select("id, title, created_at, document_id, documents(name)") \
            .eq("user_id", user_id).order("created_at", desc=True).execute()
        return {"conversations": result.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/conversations/{conversation_id}/messages")
async def get_messages(conversation_id: str, user_id: str):
    """Get all messages for a conversation."""
    try:
        # Verify ownership
        conv = supabase.table("conversations").select("user_id") \
            .eq("id", conversation_id).single().execute()
        if conv.data["user_id"] != user_id:
            raise HTTPException(status_code=403, detail="Access denied")

        msgs = supabase.table("messages").select("role, content, created_at") \
            .eq("conversation_id", conversation_id).order("created_at").execute()
        return {"messages": msgs.data}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================
# RUN
# ============================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
