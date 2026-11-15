# Framework de Controle Multiagentes: Metáfora Teatral Aplicada

> **Nota (2026-11-14).** Este texto é o registro das ideias iniciais do dono e não foi reescrito. A referência é a [arquitetura](arquitetura.md) v0.32 e o [fluxo da peça](fluxo-da-peca.md). Quando divergirem, vale a arquitetura.
>
> O que mudou:
> - O plano traz dúvidas e suposições. As dúvidas vão ao Produtor (CLARIFYING) antes do Revisor, que também julga as suposições (§5.3 e §5.4).
> - O Roteirista entrega **demandas prontas**, com critérios de aceite, contratos, `expectedFiles` e `verify`, e o roteiro passa por validação em código (§5.4).
> - O Autor revisa **todo** roteiro, inclusive o inicial, e não só a correção (REVIEWING_SCRIPT, §5.4).
> - Os Atores não têm "toda permissão": usam as cascas e os plugins do papel, com o shell nativo bloqueado (P5, §5.3 e §5.8). Quem abre as sessões é o daemon (§4).
> - Cada demanda roda o `verify` em código ao fim da tentativa. O Ator pode encerrar como `blocked`, o que conta como falha de roteiro (§5.4).
> - No timeout, o daemon faz um commit WIP, e o Diretor decide num ponto de julgamento (§5.4 e §5.5).
> - O Crítico avalia a branch integrada. Pode ser dispensado por decisão registrada do Produtor, nunca por ordem (§5.4).
> - A entrega segue `delivery.mode`, com PR por padrão; o merge direto só se o projeto permitir (§5.5).
> - Todo laço tem contador, e esgotado vai ao Produtor com um menu fixo. A exceção crítica é uma lista fechada. Numa crítica mista vence a falha mais grave, e o conflito na integração é falha de roteiro (§5.4).
> - Um pedido de mudança depois da entrega abre uma peça nova, ligada à anterior. O `task.define` segue as mesmas regras da peça (§5.4 e §5.20, v0.32).

Este documento define o pipeline de execução e retroalimentação de um sistema orquestrador de múltiplos agentes de Inteligência Artificial, mapeando conceitos de produção teatral para engenharia de software.

## 1. Definição de Escopo (Produtor)
*   **Ação:** O Produtor (Usuário, Product Owner ou Agente Gatilho) define uma necessidade. Pode ser uma nova *feature*, um projeto, *bug fixing*, análise de dados, pesquisa, resumo de documentos ou tarefa repetitiva.
*   **Papel:** Ponto de entrada do sistema. Fornece o *prompt* inicial ou requisito de negócios.

## 2. Planejamento (Autor)
*   **Ação:** O Autor recebe a necessidade do Produtor e monta um plano de ação detalhado para atendê-la.
*   **Papel:** Agente Planejador (*Planner Agent*). Transforma o desejo abstrato em uma sequência lógica de passos.

## 3. Revisão do Plano (Revisor)
*   **Ação:** O Revisor analisa o plano de ação do Autor, comparando com a necessidade do Produtor. Se encontrar falhas lógicas ou omissões, devolve ao Autor para correção; caso contrário, aprova.
*   **Papel:** Validador de Requisitos. Garante que o plano atende perfeitamente ao pedido do Produtor antes de gastar recursos de processamento.

## 4. Orquestração e Paralelismo (Roteirista)
*   **Ação:** O Roteirista recebe o plano validado e o fragmenta em tarefas executáveis (*demandas*). Define a complexidade, agrupa o que deve ser sequencial e destaca o que pode ser processado em paralelo. Ele (Roteirista) deve definir contratos rígidos (interfaces) entre as tarefas antes de enviá-las ao Diretor, garantindo que o Output do Ator A se conecte perfeitamente com o Input do Ator B.
*   **Papel:** Agente Agendador/Divisor de Tarefas (*Task Scheduler/Splitter*). Prepara o *backlog* de execução.

## 5. Execução (Diretor e Elenco de Atores)
*   **Ação:** O Diretor recebe o roteiro e aloca as tarefas para o elenco de Atores (Agentes Especializados). O Diretor monitora a execução. Cada Ator trabalha de forma independente, mas a soma de seus outputs compõe a entrega final. Atores começam com o contexto composto pelo detalhe da demanda e acesso a uma worktree e branch de trabalho (Independencia entre Atores). Atores devem ter acesso a Skills, MCPs, tools e toda permissão necessária para a completa execução do trabalho e testes que se façam necessários. O Ator terá um tempo máximo definido para a execução do seu trabalho. Estourado o tempo o trabalho do Ator será avaliado e se estiver completo o suficiente para ir para o Critico, ele segue senão ele segue para outro Ator terminar.
*   **Papel:** O Diretor atua como *Main Orchestrator* (ex: LangChain/AutoGen manager). Os Atores são as *Tools* ou *Worker Agents* (ex: Agente de Python, Agente de SQL, Agente de Web Search).

## 6. Avaliação de Qualidade (Crítico)
*   **Ação:** O Crítico analisa o output combinado dos Atores, comparando-o com o roteiro (Passo 4) e com o plano original revisado (Passo 3). Emite um parecer/análise de qualidade.
*   **Papel:** *Reward Model* ou Agente de QA (Quality Assurance). Verifica testes automatizados, coesão do código e aderência ao *prompt*.

## 7. Decisão e Merge (Diretor)
*   **Ação:** O Diretor processa a crítica. Em caso positivo, encerra a peça, realizando o PR (Pull Request) e o *merge* das execuções. Em caso negativo, aciona o fluxo de correção.
*   **Papel:** Gerenciamento de Estado e Controle de Versão (Git/Output final).
*   **Criterio de Parada:** Caso o numero de reprovações do Critico exceda um numero definido de tentativas, o Diretor deve escalar o problema para um "Erro estrutural" (Passo 2) ou em caso de uma falha crítica (Exceção) consulte o Produtor como proceder.

## 8. Ciclo de Retroalimentação (Correções)
Conforme a natureza do problema apontado pelo Crítico, o Diretor roteia o *feedback*:
*   **Falha de Execução (Retorna ao Passo 5):** Bugs no código, *timeouts* ou erros pontuais. Os Atores refazem o trabalho sob a supervisão do Diretor.
*   **Falha de Roteiro/Integração (Retorna ao Passo 4):** As tarefas foram mal divididas ou há conflito nas dependências. O Roteirista ajusta a fila de demandas, com revisão do Autor. Aprovado, volta ao Diretor.
*   **Falha Estrutural (Retorna aos Passos 1 e 2):** O plano de ação falhou em resolver o problema do Produtor. O Autor refaz o plano do zero, passa pelo Revisor, Roteirista, até nova execução.

## 9. Novo Ciclo
*   **Ação:** Com a entrega concluída, o sistema aguarda a próxima necessidade do Produtor (Retorno ao Passo 1).