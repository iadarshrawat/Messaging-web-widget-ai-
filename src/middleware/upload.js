import multer from "multer";

/**
 * Multer configuration for file uploads
 */
export const upload = multer({ 
  dest: 'uploads/',
  limits: { 
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});