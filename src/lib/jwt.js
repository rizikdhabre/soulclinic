import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;


export function signToken(payload){
    return jwt.sign(payload,SECRET,{expiresIn :"1d"})
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}