/**
 * websocket-do-zero — um servidor WebSocket sobre node:net, pela RFC 6455.
 */

export { ServidorWebSocket, servir } from './servidor.js';
export { Conexao, ESTADOS } from './conexao.js';
export { conectar, proximaMensagem, lerEndereco, lerResposta, pedidoDeUpgrade, ErroDeConexao } from './cliente.js';

export {
  ErroDeAperto,
  GUID,
  VERSAO,
  chaveNova,
  conferirPedido,
  escolherProtocolo,
  resposta101,
  respostaDeRecusa,
  respostaPara,
} from './aperto.js';

export {
  ErroDeProtocolo,
  FECHAMENTO,
  MAXIMO_DE_CONTROLE,
  NOMES,
  OPCODES,
  RESERVADOS,
  cargaDeFechamento,
  ehControle,
  lerFechamento,
  lerQuadro,
  mascarar,
  montarQuadro,
} from './quadro.js';
